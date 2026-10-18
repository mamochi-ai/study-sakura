import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { addBook, BINDER_COLORS, BOOK_COLORS, createBinder, db, deleteBinder, deleteBook, type Binder, type Book } from '../db';
import { saveErrorText } from '../lib/errors';
import { formatSize } from '../lib/format';
import { forgetBookPdf } from '../lib/pdf';
import { storageSpace, useStorageSpace } from '../lib/storage';
import { updateSettings, useSettings } from '../lib/settings';
import { confirmDialog, Modal, toast } from './Modal';
import { BookCover } from './Shelf';

export function ColorPicker({ colors, value, onChange }: { colors: string[]; value: string; onChange: (c: string) => void }) {
  return (
    <div className="color-picker">
      {colors.map((c) => (
        <button
          key={c}
          className={`swatch${c === value ? ' active' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
          aria-label={`色 ${c}`}
          type="button"
        />
      ))}
    </div>
  );
}

/** PDF を選んで本棚に追加する */
export async function pickAndAddBooks(files: FileList | File[] | null): Promise<Book[]> {
  const pdfs = Array.from(files ?? []).filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const added: Book[] = [];
  if (!pdfs.length) return added;
  // 空き容量を先に確かめる（ノートを保存する分も少し残す）
  const need = pdfs.reduce((a, f) => a + f.size, 0);
  const space = await storageSpace();
  if (space && need + 50 * 1024 * 1024 > space.free) {
    toast(`空き容量が足りません（追加する参考書 ${formatSize(need)}・空き ${formatSize(space.free)}）。不要な参考書を削除するか、iPad の空きを増やしてください`);
    return added;
  }
  for (const f of pdfs) {
    try {
      added.push(await addBook(f));
    } catch (e) {
      toast(`「${f.name}」を追加できませんでした：${saveErrorText(e)}`);
      break;
    }
  }
  if (added.length) toast(`${added.length} 冊の参考書を本棚に追加しました`);
  return added;
}

/* ---------- バインダーの作成・編集 ---------- */

export function BinderDialog({
  binder,
  initialBookIds = [],
  onClose,
  onCreated,
}: {
  binder?: Binder;
  initialBookIds?: string[];
  onClose: () => void;
  onCreated?: (b: Binder) => void;
}) {
  const books = useLiveQuery(() => db.books.orderBy('createdAt').toArray(), []) ?? [];
  const [title, setTitle] = useState(binder?.title ?? '');
  const [color, setColor] = useState(binder?.color ?? BINDER_COLORS[Math.floor(Math.random() * BINDER_COLORS.length)]);
  const [bookIds, setBookIds] = useState<string[]>(binder?.bookIds ?? initialBookIds);
  const fileRef = useRef<HTMLInputElement>(null);

  const toggle = (id: string) => setBookIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const save = async () => {
    const name = title.trim() || '新しいバインダー';
    if (binder) {
      await db.binders.update(binder.id, {
        title: name,
        color,
        bookIds,
        activeBookId: bookIds.includes(binder.activeBookId ?? '') ? binder.activeBookId : bookIds[0],
        updatedAt: Date.now(),
      });
      onClose();
    } else {
      const b = await createBinder(name, color, bookIds);
      onClose();
      onCreated?.(b);
    }
  };

  const remove = async () => {
    if (!binder) return;
    const ok = await confirmDialog({
      title: 'バインダーを削除',
      message: `「${binder.title}」と中のノートをすべて削除します。\n参考書は本棚に残ります。`,
      danger: true,
      okLabel: '削除する',
    });
    if (!ok) return;
    await deleteBinder(binder.id);
    onClose();
  };

  return (
    <Modal
      title={binder ? 'バインダーを編集' : '新しいバインダー'}
      onClose={onClose}
      width={520}
      footer={
        <>
          {binder && (
            <button className="btn danger ghost" onClick={remove} style={{ marginRight: 'auto' }}>
              削除
            </button>
          )}
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" onClick={save}>{binder ? '保存' : '作成して開く'}</button>
        </>
      }
    >
      <label className="field">
        <span>バインダー名（科目など）</span>
        <input autoFocus value={title} placeholder="例：線形代数" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && save()} />
      </label>
      <div className="field">
        <span>色</span>
        <ColorPicker colors={BINDER_COLORS} value={color} onChange={setColor} />
      </div>
      <div className="field">
        <span>セットにする参考書（あとから変更できます）</span>
        <div className="book-select">
          {books.map((b) => (
            <label key={b.id} className={`book-option${bookIds.includes(b.id) ? ' checked' : ''}`}>
              <input type="checkbox" checked={bookIds.includes(b.id)} onChange={() => toggle(b.id)} />
              <BookCover book={b} size={36} />
              <span className="book-option-title">{b.title}</span>
              {bookIds.includes(b.id) && <span className="book-option-order">{bookIds.indexOf(b.id) + 1}</span>}
            </label>
          ))}
          <button className="book-option add" type="button" onClick={() => fileRef.current?.click()}>
            ＋ PDF を本棚に追加
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={async (e) => {
              const added = await pickAndAddBooks(e.target.files);
              setBookIds((ids) => [...ids, ...added.map((b) => b.id)]);
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </Modal>
  );
}

/* ---------- 参考書の詳細 ---------- */

export function BookDialog({ book, onClose, onCreateBinder }: { book: Book; onClose: () => void; onCreateBinder: (bookId: string) => void }) {
  const [title, setTitle] = useState(book.title);
  const [color, setColor] = useState(book.color);
  const usedBy = useLiveQuery(() => db.binders.filter((b) => b.bookIds.includes(book.id)).toArray(), [book.id]) ?? [];

  const save = async () => {
    await db.books.update(book.id, { title: title.trim() || book.title, color });
    onClose();
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: '参考書を削除',
      message: `「${book.title}」を本棚から削除します。${usedBy.length ? `\n${usedBy.length} 冊のバインダーからも外れます（ノートは残ります）。` : ''}\nノートの中のこの参考書へのページリンク・引用元は、押しても開けなくなります。`,
      danger: true,
      okLabel: '削除する',
    });
    if (!ok) return;
    forgetBookPdf(book.id);
    await deleteBook(book.id);
    onClose();
  };

  return (
    <Modal
      title="参考書"
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="btn danger ghost" onClick={remove} style={{ marginRight: 'auto' }}>削除</button>
          <button className="btn" onClick={() => onCreateBinder(book.id)}>この参考書でバインダーを作る</button>
          <button className="btn primary" onClick={save}>保存</button>
        </>
      }
    >
      <div className="book-detail">
        <BookCover book={book} size={120} />
        <div className="book-detail-info">
          <label className="field">
            <span>書名</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="field">
            <span>背表紙の色</span>
            <ColorPicker colors={BOOK_COLORS} value={color} onChange={setColor} />
          </div>
          <p className="muted small">
            {book.pageCount ? `${book.pageCount} ページ・` : ''}
            {(book.size / 1024 / 1024).toFixed(1)} MB
          </p>
          {usedBy.length > 0 && (
            <p className="muted small">使用中のバインダー：{usedBy.map((b) => b.title).join('、')}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ---------- 設定 ---------- */

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const space = useStorageSpace();
  const books = useLiveQuery(() => db.books.toArray().then((l) => ({ count: l.length, size: l.reduce((a, b) => a + b.size, 0) })), []);
  return (
    <Modal title="設定" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>閉じる</button>}>
      <div className="field">
        <span>テーマ</span>
        <div className="segmented">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button key={t} className={s.theme === t ? 'active' : ''} onClick={() => updateSettings({ theme: t })}>
              {{ light: '昼（ライト）', dark: '夜（ダーク）', system: '自動' }[t]}
            </button>
          ))}
        </div>
      </div>
      <div className="field-row">
        <label className="field">
          <span>ポモドーロ 集中（分）</span>
          <input type="number" min={1} max={120} value={s.pomodoroWork} onChange={(e) => updateSettings({ pomodoroWork: Math.max(1, +e.target.value || 25) })} />
        </label>
        <label className="field">
          <span>休憩（分）</span>
          <input type="number" min={1} max={60} value={s.pomodoroBreak} onChange={(e) => updateSettings({ pomodoroBreak: Math.max(1, +e.target.value || 5) })} />
        </label>
      </div>
      <label className="field">
        <span>ノートの文字サイズ：{s.noteFontSize}px</span>
        <input type="range" min={12} max={24} value={s.noteFontSize} onChange={(e) => updateSettings({ noteFontSize: +e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={s.syncNotePage} onChange={(e) => updateSettings({ syncNotePage: e.target.checked })} />
        ノートを切り替えたら、そのノートで最後に見ていた参考書のページを開く
      </label>
      <label className="check">
        <input type="checkbox" checked={s.allowPageZoom} onChange={(e) => updateSettings({ allowPageZoom: e.target.checked })} />
        画面全体を 2 本指で拡大できるようにする（文字が見えにくいとき。参考書と手書きノートの上では、それぞれの拡大・スクロールが優先されます）
      </label>
      <div className="field storage-usage">
        <span>保存しているデータ</span>
        <div>
          参考書 {books?.count ?? 0} 冊（{formatSize(books?.size ?? 0)}）
          {space && (
            <>
              ・全体 {formatSize(space.usage)}／使える容量 {formatSize(space.quota)}
              <div className="usage-bar">
                <span style={{ width: `${Math.min(100, (space.usage / space.quota) * 100)}%` }} />
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
