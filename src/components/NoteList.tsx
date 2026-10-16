import { useState } from 'react';
import { addNote, db, type Note } from '../db';
import { formatDate } from '../lib/format';
import { askText, confirmDialog } from './Modal';

/** バインダーのインデックス（ノートの一覧） */
export default function NoteList({
  notes,
  activeId,
  binderId,
  onSelect,
  onCollapse,
}: {
  notes: Note[];
  activeId?: string;
  binderId: string;
  onSelect: (id: string) => void;
  onCollapse: () => void;
}) {
  const [query, setQuery] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = q ? notes.filter((n) => n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q)) : notes;

  const create = async () => {
    const n = await addNote(binderId);
    onSelect(n.id);
  };

  const rename = async (n: Note) => {
    const t = await askText({ title: 'ノートの名前', value: n.title });
    if (t?.trim()) await db.notes.update(n.id, { title: t.trim(), updatedAt: Date.now() });
  };

  const duplicate = async (n: Note) => {
    const copy = await addNote(binderId, { title: `${n.title}（コピー）`, content: n.content, text: n.text, bookId: n.bookId, page: n.page });
    onSelect(copy.id);
  };

  const remove = async (n: Note) => {
    const ok = await confirmDialog({ title: 'ノートを削除', message: `「${n.title}」を削除しますか？\nこの操作は元に戻せません。`, danger: true, okLabel: '削除する' });
    if (!ok) return;
    const idx = notes.findIndex((x) => x.id === n.id);
    await db.notes.delete(n.id);
    if (n.id === activeId) {
      const next = notes[idx + 1] ?? notes[idx - 1];
      if (next) onSelect(next.id);
      else onSelect((await addNote(binderId)).id);
    }
  };

  const drop = async (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = notes.map((n) => n.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    await db.transaction('rw', db.notes, async () => {
      await Promise.all(ids.map((id, i) => db.notes.update(id, { order: i })));
    });
  };

  return (
    <aside className="note-list">
      <div className="note-list-head">
        <input className="search-input" placeholder="🔍 ノートを検索" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="icon-btn" onClick={onCollapse} title="一覧を閉じる">«</button>
      </div>
      <ul>
        {filtered.map((n) => (
          <li
            key={n.id}
            className={`note-item${n.id === activeId ? ' active' : ''}${overId === n.id ? ' drag-over' : ''}`}
            draggable={!q}
            onDragStart={() => setDragId(n.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              setOverId(n.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(n.id);
              setOverId(null);
            }}
          >
            <button className="note-item-main" onClick={() => onSelect(n.id)} onDoubleClick={() => rename(n)}>
              <span className="note-item-title">{n.title}</span>
              <span className="note-item-sub">
                {q && n.text.toLowerCase().includes(q) ? snippet(n.text, q) : formatDate(n.updatedAt)}
              </span>
            </button>
            <details className="menu note-item-menu">
              <summary className="icon-btn tiny" aria-label="ノートのメニュー">⋯</summary>
              <div className="menu-list right">
                <button onClick={() => rename(n)}>名前を変更</button>
                <button onClick={() => duplicate(n)}>複製</button>
                <button className="danger" onClick={() => remove(n)}>削除</button>
              </div>
            </details>
          </li>
        ))}
        {filtered.length === 0 && <li className="muted small pad">見つかりません</li>}
      </ul>
      <button className="note-add" onClick={create}>＋ 新しいノート</button>
    </aside>
  );
}

function snippet(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q);
  return `…${text.slice(Math.max(0, i - 8), i + q.length + 16).replace(/\s+/g, ' ')}…`;
}
