import { useEffect, useRef, useState } from 'react';
import { addNote, db, deleteNote, duplicateNote, type Note, type NoteKind } from '../db';
import { formatDate } from '../lib/format';
import { getSettings } from '../lib/settings';
import { askText, confirmDialog } from './Modal';

const kindIcon = (n: Note) => (n.kind === 'ink' ? '✏️' : '📝');

export async function createNote(binderId: string, kind: NoteKind) {
  return addNote(binderId, { kind, paper: getSettings().defaultPaper, title: kind === 'ink' ? '手書きノート' : '無題のノート' });
}

/** ノートの上に並ぶインデックスタブ（バインダーの見出しのイメージ） */
export function NoteTabs({
  notes,
  activeId,
  binderId,
  onSelect,
}: {
  notes: Note[];
  activeId?: string;
  binderId: string;
  onSelect: (id: string) => void;
}) {
  const [listOpen, setListOpen] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  // 選んだタブが見えるようにスクロール
  useEffect(() => {
    // scrollIntoView は画面全体までずらすことがあるので、タブの列だけを横に動かす
    const strip = stripRef.current;
    const tab = strip?.querySelector<HTMLElement>('.note-tab.active');
    if (!strip || !tab) return;
    if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth;
  }, [activeId]);

  const create = async (kind: NoteKind) => onSelect((await createNote(binderId, kind)).id);

  return (
    <div className="note-tabs-bar">
      <button className={`icon-btn${listOpen ? ' active' : ''}`} onClick={() => setListOpen(!listOpen)} title="ノート一覧・検索" aria-label="ノート一覧">
        ☰
      </button>
      <div className="note-tabs" ref={stripRef} role="tablist" aria-label="ノート">
        {notes.map((n) => (
          <button
            key={n.id}
            role="tab"
            aria-selected={n.id === activeId}
            className={`note-tab${n.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(n.id)}
            title={n.title}
          >
            <span className="note-tab-icon">{kindIcon(n)}</span>
            {n.title}
          </button>
        ))}
      </div>
      <details className="menu">
        <summary className="icon-btn" title="新しいノート" aria-label="新しいノート">＋</summary>
        <div className="menu-list right">
          <button onClick={() => create('text')}>📝 テキストノート</button>
          <button onClick={() => create('ink')}>✏️ 手書きノート（Apple Pencil）</button>
        </div>
      </details>
      {listOpen && (
        <NoteList
          notes={notes}
          activeId={activeId}
          binderId={binderId}
          onSelect={(id) => {
            onSelect(id);
            setListOpen(false);
          }}
          onClose={() => setListOpen(false)}
        />
      )}
    </div>
  );
}

/** ノート一覧（検索・並べ替え・名前変更・複製・削除）。ノートの上に重ねて開く */
function NoteList({
  notes,
  activeId,
  binderId,
  onSelect,
  onClose,
}: {
  notes: Note[];
  activeId?: string;
  binderId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = q ? notes.filter((n) => n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q)) : notes;

  const rename = async (n: Note) => {
    const t = await askText({ title: 'ノートの名前', value: n.title });
    if (t?.trim()) await db.notes.update(n.id, { title: t.trim(), updatedAt: Date.now() });
  };

  const remove = async (n: Note) => {
    const ok = await confirmDialog({ title: 'ノートを削除', message: `「${n.title}」を削除しますか？\nこの操作は元に戻せません。`, danger: true, okLabel: '削除する' });
    if (!ok) return;
    const idx = notes.findIndex((x) => x.id === n.id);
    await deleteNote(n.id);
    if (n.id === activeId) {
      const next = notes[idx + 1] ?? notes[idx - 1];
      if (next) onSelect(next.id);
      else onSelect((await createNote(binderId, 'text')).id);
    }
  };

  const reorder = async (ids: string[]) => {
    await db.transaction('rw', db.notes, async () => {
      await Promise.all(ids.map((id, i) => db.notes.update(id, { order: i })));
    });
  };
  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = notes.map((n) => n.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    reorder(ids);
  };
  const move = (n: Note, dir: -1 | 1) => {
    const ids = notes.map((x) => x.id);
    const i = ids.indexOf(n.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(ids);
  };

  return (
    <>
      <div className="note-list-backdrop" onPointerDown={onClose} />
      <aside className="note-list" aria-label="ノート一覧">
        <div className="note-list-head">
          <input className="search-input" placeholder="🔍 ノートを検索" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="icon-btn" onClick={onClose} aria-label="一覧を閉じる">✕</button>
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
                <span className="note-item-title">{kindIcon(n)} {n.title}</span>
                <span className="note-item-sub">
                  {q && n.text.toLowerCase().includes(q) ? snippet(n.text, q) : formatDate(n.updatedAt)}
                </span>
              </button>
              <details className="menu note-item-menu">
                <summary className="icon-btn tiny" aria-label="ノートのメニュー">⋯</summary>
                <div className="menu-list right">
                  <button onClick={() => rename(n)}>名前を変更</button>
                  <button onClick={() => move(n, -1)}>↑ 上へ移動</button>
                  <button onClick={() => move(n, 1)}>↓ 下へ移動</button>
                  <button onClick={async () => onSelect((await duplicateNote(n)).id)}>複製</button>
                  <button className="danger" onClick={() => remove(n)}>削除</button>
                </div>
              </details>
            </li>
          ))}
          {filtered.length === 0 && <li className="muted small pad">見つかりません</li>}
        </ul>
      </aside>
    </>
  );
}

function snippet(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q);
  return `…${text.slice(Math.max(0, i - 8), i + q.length + 16).replace(/\s+/g, ' ')}…`;
}
