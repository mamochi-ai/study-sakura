import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BinderDialog, SettingsDialog } from '../components/Dialogs';
import { toast } from '../components/Modal';
import NoteEditor from '../components/NoteEditor';
import InkEditor from '../components/InkEditor';
import { NoteTabs } from '../components/NoteList';
import { PdfPane, type PdfPaneHandle } from '../components/PdfPane';
import { StudyTimer } from '../components/StudyTimer';
import { addNote, db, type Book, type ReadingPosition } from '../db';
import { getSettings } from '../lib/settings';
import { insertPageRef, StudyBusContext, type StudyBus } from './studyBus';

type Layout = 'split' | 'pdf' | 'note';

function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const mq = matchMedia('(max-width: 760px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export default function StudyView({ binderId, onBack }: { binderId: string; onBack: () => void }) {
  const binder = useLiveQuery(() => db.binders.get(binderId), [binderId], null);
  const allBooks = useLiveQuery(() => db.books.toArray(), []);
  const notes = useLiveQuery(() => db.notes.where('[binderId+order]').between([binderId, -Infinity], [binderId, Infinity]).toArray(), [binderId]);
  const [layout, setLayout] = useState<Layout>('split');
  const [ratio, setRatio] = useState<number | null>(null);
  const [editBinder, setEditBinder] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const narrow = useNarrow();
  const pdfRef = useRef<PdfPaneHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const books = useMemo(
    () => (binder && allBooks ? binder.bookIds.map((id) => allBooks.find((b) => b.id === id)).filter((b): b is Book => !!b) : []),
    [binder, allBooks],
  );
  const activeBookId = binder?.activeBookId && books.some((b) => b.id === binder.activeBookId) ? binder.activeBookId : books[0]?.id;
  const activeNote = notes?.find((n) => n.id === binder?.lastNoteId) ?? notes?.[0];

  // PDF とノートをつなぐ
  const bus = useRef<StudyBus>({
    openPage: () => {},
    current: () => null,
    bookTitle: () => '',
    editor: null,
  });
  bus.current.openPage = (bookId, page) => pdfRef.current?.openPage(bookId, page);
  bus.current.current = () => (activeBookId && pdfRef.current ? { bookId: activeBookId, page: pdfRef.current.currentPage() } : null);
  bus.current.bookTitle = (id) => allBooks?.find((b) => b.id === id)?.title ?? '';

  useEffect(() => {
    db.binders.update(binderId, { lastOpenedAt: Date.now() });
  }, [binderId]);

  // 存在しないバインダー（削除された等）なら本棚に戻る
  useEffect(() => {
    if (binder === undefined) onBack();
  }, [binder, onBack]);

  // ノートが 1 枚もなければ作る
  useEffect(() => {
    if (notes && notes.length === 0) addNote(binderId, { title: '無題のノート' }).then((n) => db.binders.update(binderId, { lastNoteId: n.id }));
  }, [notes, binderId]);

  const selectBook = useCallback((bookId: string) => db.binders.update(binderId, { activeBookId: bookId }), [binderId]);

  // 読んでいる位置をバインダー（と開いているノート）に記録
  const posTimer = useRef<ReturnType<typeof setTimeout>>();
  const activeNoteId = useRef<string | undefined>();
  activeNoteId.current = activeNote?.id;
  const onPositionChange = useCallback(
    (bookId: string, pos: ReadingPosition) => {
      clearTimeout(posTimer.current);
      const noteId = activeNoteId.current;
      posTimer.current = setTimeout(async () => {
        await db.binders.where('id').equals(binderId).modify((b) => {
          b.positions[bookId] = pos;
          b.activeBookId = bookId;
        });
        if (noteId) await db.notes.update(noteId, { bookId, page: pos.page });
      }, 400);
    },
    [binderId],
  );

  const selectNote = (id: string) => {
    if (id === activeNote?.id) return;
    db.binders.update(binderId, { lastNoteId: id });
    const n = notes?.find((x) => x.id === id);
    // そのノートで見ていたページへ（参考書は選び直さなくてよい）
    if (n?.bookId && n.page && getSettings().syncNotePage && binder?.bookIds.includes(n.bookId)) {
      clearTimeout(posTimer.current);
      pdfRef.current?.openPage(n.bookId, n.page);
    }
  };

  // 分割バーのドラッグ
  const startDrag = (e: React.PointerEvent) => {
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    const rect = body.getBoundingClientRect();
    let last = ratio ?? binder?.splitRatio ?? 0.5;
    const move = (ev: PointerEvent) => {
      const r = narrow ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
      last = Math.min(0.85, Math.max(0.15, r));
      setRatio(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      db.binders.update(binderId, { splitRatio: last });
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ショートカット
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        toast('ノートは自動で保存されています');
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        const cur = bus.current.current();
        if (cur) insertPageRef(bus.current, cur.bookId, cur.page);
      } else if (e.altKey && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault();
        setLayout(({ '1': 'pdf', '2': 'split', '3': 'note' } as const)[e.key as '1' | '2' | '3']);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!binder || !notes) return <div className="study-view loading">読み込み中…</div>;

  const split = ratio ?? binder.splitRatio ?? 0.5;
  const pdfSize = layout === 'pdf' ? 1 : layout === 'note' ? 0 : split;

  return (
    <StudyBusContext.Provider value={bus}>
      <div className="study-view" style={{ '--binder-color': binder.color } as React.CSSProperties}>
        <header className="study-header">
          <button className="btn ghost" onClick={onBack} title="本棚に戻る">← 本棚</button>
          <button className="binder-title" onClick={() => setEditBinder(true)} title="バインダーを編集">
            <span className="binder-dot" />
            {binder.title}
          </button>
          <div className="segmented layout-switch" role="group" aria-label="表示">
            <button className={layout === 'pdf' ? 'active' : ''} onClick={() => setLayout('pdf')} title="参考書だけ (Alt+1)">📖</button>
            <button className={layout === 'split' ? 'active' : ''} onClick={() => setLayout('split')} title="並べて表示 (Alt+2)">📖│📝</button>
            <button className={layout === 'note' ? 'active' : ''} onClick={() => setLayout('note')} title="ノートだけ (Alt+3)">📝</button>
          </div>
          <div className="tb-spacer" />
          <StudyTimer binderId={binderId} />
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="設定">⚙</button>
        </header>

        <div ref={bodyRef} className={`study-body${narrow ? ' vertical' : ''}`}>
          <section className="pane pdf-side" style={{ flexBasis: `${pdfSize * 100}%`, display: pdfSize === 0 ? 'none' : undefined }}>
            <PdfPane
              ref={pdfRef}
              books={books}
              activeBookId={activeBookId}
              position={activeBookId ? binder.positions[activeBookId] : undefined}
              onSelectBook={selectBook}
              onEditBooks={() => setEditBinder(true)}
              onPositionChange={onPositionChange}
            />
          </section>
          {layout === 'split' && (
            <div
              className="divider"
              role="separator"
              aria-orientation={narrow ? 'horizontal' : 'vertical'}
              onPointerDown={startDrag}
              onDoubleClick={() => {
                setRatio(0.5);
                db.binders.update(binderId, { splitRatio: 0.5 });
              }}
              title="ドラッグで幅を調整（ダブルクリックで半分ずつ）"
            />
          )}
          <section className="pane note-side" style={{ flexBasis: `${(1 - pdfSize) * 100}%`, display: pdfSize === 1 ? 'none' : undefined }}>
            <NoteTabs notes={notes} activeId={activeNote?.id} binderId={binderId} onSelect={selectNote} />
            {!activeNote ? (
              <div className="note-editor" />
            ) : activeNote.kind === 'ink' ? (
              <InkEditor key={activeNote.id} note={activeNote} />
            ) : (
              <NoteEditor key={activeNote.id} note={activeNote} />
            )}
          </section>
        </div>

        {editBinder && <BinderDialog binder={binder} onClose={() => setEditBinder(false)} />}
        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      </div>
    </StudyBusContext.Provider>
  );
}
