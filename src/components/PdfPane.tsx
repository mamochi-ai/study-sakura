import { useLiveQuery } from 'dexie-react-hooks';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { db, uid, type Book, type ReadingPosition } from '../db';
import { getAllText, getOutline, loadBookPdf, type OutlineItem, type PDFDocumentProxy } from '../lib/pdf';
import { insertFromPdf, insertPageRef, useStudyBus } from '../views/studyBus';
import { askText, toast } from './Modal';
import { PdfViewer, type PdfViewerHandle } from './PdfViewer';

export interface PdfPaneHandle {
  openPage: (bookId: string, page: number) => void;
  currentPage: () => number;
}

interface Props {
  books: Book[];
  activeBookId?: string;
  position?: ReadingPosition;
  onSelectBook: (bookId: string) => void;
  onEditBooks: () => void;
  onPositionChange: (bookId: string, pos: ReadingPosition) => void;
}

const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export const PdfPane = forwardRef<PdfPaneHandle, Props>(function PdfPane(
  { books, activeBookId, position, onSelectBook, onEditBooks, onPositionChange },
  ref,
) {
  const bus = useStudyBus();
  const viewer = useRef<PdfViewerHandle>(null);
  const [doc, setDoc] = useState<{ bookId: string; doc: PDFDocumentProxy } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(position?.page ?? 1);
  const [zoom, setZoom] = useState<number | 'fit'>(position?.zoom ?? 'fit');
  const [fitScale, setFitScale] = useState(1);
  const [capture, setCapture] = useState(false);
  const [sidebar, setSidebar] = useState<'outline' | 'bookmarks' | 'search' | null>(null);
  const [selection, setSelection] = useState<{ text: string; page: number; x: number; y: number; bottom: number } | null>(null);
  const pendingPage = useRef<number | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;

  const scale = zoom === 'fit' ? fitScale : zoom;

  // 参考書を切り替えたら読み込み直す（位置はバインダーが覚えている）
  useEffect(() => {
    setDoc(null);
    setError(null);
    setSelection(null);
    if (!activeBookId) return;
    let alive = true;
    loadBookPdf(activeBookId)
      .then((d) => {
        if (!alive) return;
        db.books.update(activeBookId, { lastOpenedAt: Date.now() });
        const start = pendingPage.current ?? position?.page ?? 1;
        pendingPage.current = null;
        setPage(start);
        setZoom(position?.zoom ?? 'fit');
        setDoc({ bookId: activeBookId, doc: d });
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
    // position は参考書を開いた瞬間の値だけを使う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBookId]);

  const report = useRef(onPositionChange);
  report.current = onPositionChange;
  useEffect(() => {
    if (doc) report.current(doc.bookId, { page, zoom });
  }, [doc, page, zoom]);

  const goTo = useCallback((p: number, smooth = false) => {
    if (!doc) return;
    const target = Math.min(Math.max(1, p), doc.doc.numPages);
    setPage(target);
    viewer.current?.goTo(target, smooth);
  }, [doc]);

  useImperativeHandle(ref, () => ({
    openPage: (bookId, p) => {
      if (bookId === doc?.bookId) goTo(p, true);
      else if (books.some((b) => b.id === bookId)) {
        pendingPage.current = p;
        onSelectBook(bookId);
      } else toast('この参考書はバインダーに入っていません');
    },
    currentPage: () => pageRef.current,
  }), [doc, goTo, books, onSelectBook]);

  const zoomStep = useCallback((dir: 1 | -1) => {
    setZoom((z) => {
      const cur = z === 'fit' ? fitScale : z;
      const next = dir > 0 ? ZOOMS.find((v) => v > cur + 0.01) : [...ZOOMS].reverse().find((v) => v < cur - 0.01);
      return next ?? cur;
    });
  }, [fitScale]);
  const onCtrlWheel = useCallback((dy: number) => zoomStep(dy < 0 ? 1 : -1), [zoomStep]);

  // PDF 側にフォーカスがあるときのキー操作
  const paneRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,textarea')) return;
    if (e.key === 'PageDown' || e.key === 'ArrowRight') { e.preventDefault(); goTo(page + 1); }
    else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); goTo(page - 1); }
    else if (e.key === 'Home') { e.preventDefault(); goTo(1); }
    else if (e.key === 'End' && doc) { e.preventDefault(); goTo(doc.doc.numPages); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomStep(-1); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); setSidebar('search'); }
    else if (e.key === 'Escape') setCapture(false);
  };

  const onCapture = async (p: number, rect: { x: number; y: number; w: number; h: number }) => {
    if (!doc || !viewer.current) return;
    const src = await viewer.current.capture(p, rect);
    if (!src) return;
    if (insertFromPdf(bus.current, { kind: 'image', src, bookId: doc.bookId, page: p })) toast(`p.${p} の切り抜きをノートに貼りました`);
    else toast('テキストノートを開いてから使ってください');
  };

  const activeBook = books.find((b) => b.id === activeBookId);

  return (
    <div className="pdf-pane" ref={paneRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="book-tabs" role="tablist" aria-label="参考書">
        {books.map((b) => (
          <button
            key={b.id}
            role="tab"
            aria-selected={b.id === activeBookId}
            className={`book-tab${b.id === activeBookId ? ' active' : ''}`}
            style={{ '--spine-color': b.color } as React.CSSProperties}
            onClick={() => onSelectBook(b.id)}
            title={b.title}
          >
            {b.title}
          </button>
        ))}
        <button className="book-tab add" onClick={onEditBooks} title="参考書を追加・入れ替え">＋</button>
      </div>

      {activeBook && (
        <div className="pdf-toolbar">
          <button className={`icon-btn${sidebar ? ' active' : ''}`} onClick={() => setSidebar(sidebar ? null : 'outline')} title="目次・しおり・検索">☰</button>
          <div className="tb-group">
            <button className="icon-btn" onClick={() => goTo(page - 1)} disabled={page <= 1} title="前のページ (←)">‹</button>
            <PageInput page={page} total={doc?.doc.numPages ?? 0} onGo={(p) => goTo(p)} />
            <button className="icon-btn" onClick={() => goTo(page + 1)} disabled={!doc || page >= doc.doc.numPages} title="次のページ (→)">›</button>
          </div>
          <div className="tb-group">
            <button className="icon-btn" onClick={() => zoomStep(-1)} title="縮小 (Ctrl+-)">−</button>
            <button className="zoom-label" onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')} title="クリックで「幅に合わせる」/「100%」を切り替え">
              {zoom === 'fit' ? <>幅<span className="tb-text">に合わせる</span></> : `${Math.round(scale * 100)}%`}
            </button>
            <button className="icon-btn" onClick={() => zoomStep(1)} title="拡大 (Ctrl+=)">＋</button>
          </div>
          <div className="tb-spacer" />
          <button
            className={`btn small${capture ? ' primary' : ''}`}
            onClick={() => setCapture(!capture)}
            title="ドラッグした範囲を画像としてノートに貼り付け (Esc で終了)"
          >
            ✂<span className="tb-text"> 切り取り</span>
          </button>
          <button
            className="btn small"
            onClick={() => {
              if (!doc || !insertPageRef(bus.current, doc.bookId, page)) toast('テキストノートを開いてから使ってください');
            }}
            title="このページへのリンクをノートに挿入 (Ctrl+Shift+P)"
          >
            📖<span className="tb-text"> </span>p.{page}<span className="tb-text"> を参照</span>
          </button>
          <button
            className="icon-btn"
            onClick={async () => {
              if (!doc) return;
              const label = await askText({ title: `p.${page} にしおりを挟む`, label: 'メモ（任意）', value: '' });
              if (label === null) return;
              await db.bookmarks.add({ id: uid(), bookId: doc.bookId, page, label, createdAt: Date.now() });
              toast(`p.${page} にしおりを挟みました`);
            }}
            title="しおりを挟む"
          >
            🔖
          </button>
        </div>
      )}

      <div className="pdf-body">
        {sidebar && doc && (
          <PdfSidebar
            tab={sidebar}
            onTab={setSidebar}
            doc={doc.doc}
            bookId={doc.bookId}
            page={page}
            onGo={(p) => goTo(p)}
          />
        )}
        <div className="pdf-main">
          {!activeBook && (
            <div className="pdf-empty">
              <p>このバインダーにはまだ参考書がありません。</p>
              <button className="btn primary" onClick={onEditBooks}>本棚から参考書を選ぶ</button>
            </div>
          )}
          {error && <div className="pdf-empty">PDF を開けませんでした：{error}</div>}
          {doc && (
            <PdfViewer
              key={doc.bookId}
              ref={viewer}
              doc={doc.doc}
              scale={scale}
              initialPage={page}
              captureMode={capture}
              onPageChange={setPage}
              onCapture={onCapture}
              onTextSelect={setSelection}
              onFitWidth={setFitScale}
              onCtrlWheel={onCtrlWheel}
              onPinchZoom={(f) => setZoom(Math.min(4, Math.max(0.3, Math.round(scale * f * 100) / 100)))}
            />
          )}
          {capture && <div className="capture-hint">ノートに貼りたい範囲をドラッグ　<button className="btn small" onClick={() => setCapture(false)}>終了</button></div>}
        </div>
      </div>

      {selection && doc && (
        <div
          // iPad では選択範囲の上に OS のメニューが出るので、こちらは下に出す
          className={`selection-pop${selection.y < 140 || IS_TOUCH ? ' below' : ''}`}
          style={{
            left: Math.min(Math.max(selection.x, 110), window.innerWidth - 110),
            top: IS_TOUCH ? selection.bottom + 14 : selection.y < 140 ? selection.bottom + 8 : selection.y,
          }} onMouseDown={(e) => e.preventDefault()}>
          <button
            onClick={() => {
              if (insertFromPdf(bus.current, { kind: 'text', text: selection.text, bookId: doc.bookId, page: selection.page })) toast('引用をノートに追加しました');
              else toast('テキストノートを開いてから使ってください');
              setSelection(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            ❝ ノートに引用
          </button>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(selection.text);
              toast('コピーしました');
              setSelection(null);
            }}
          >
            コピー
          </button>
        </div>
      )}
    </div>
  );
});

function PageInput({ page, total, onGo }: { page: number; total: number; onGo: (p: number) => void }) {
  const [v, setV] = useState(String(page));
  useEffect(() => setV(String(page)), [page]);
  return (
    <span className="page-input">
      <input
        value={v}
        inputMode="numeric"
        aria-label="ページ番号"
        onChange={(e) => setV(e.target.value.replace(/[^0-9０-９]/g, ''))}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = parseInt(v.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)), 10);
            if (n) onGo(n);
            (e.target as HTMLInputElement).blur();
          }
        }}
        onBlur={() => setV(String(page))}
      />
      <span className="muted"> / {total || '–'}</span>
    </span>
  );
}

/* ---------- 目次・しおり・検索 ---------- */

function PdfSidebar({
  tab,
  onTab,
  doc,
  bookId,
  page,
  onGo,
}: {
  tab: 'outline' | 'bookmarks' | 'search';
  onTab: (t: 'outline' | 'bookmarks' | 'search') => void;
  doc: PDFDocumentProxy;
  bookId: string;
  page: number;
  onGo: (p: number) => void;
}) {
  return (
    <aside className="pdf-sidebar">
      <div className="side-tabs">
        <button className={tab === 'outline' ? 'active' : ''} onClick={() => onTab('outline')}>目次</button>
        <button className={tab === 'bookmarks' ? 'active' : ''} onClick={() => onTab('bookmarks')}>しおり</button>
        <button className={tab === 'search' ? 'active' : ''} onClick={() => onTab('search')}>検索</button>
      </div>
      <div className="side-body">
        {tab === 'outline' && <Outline doc={doc} onGo={onGo} />}
        {tab === 'bookmarks' && <Bookmarks bookId={bookId} page={page} onGo={onGo} />}
        {tab === 'search' && <Search doc={doc} onGo={onGo} />}
      </div>
    </aside>
  );
}

function Outline({ doc, onGo }: { doc: PDFDocumentProxy; onGo: (p: number) => void }) {
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  useEffect(() => {
    getOutline(doc).then(setItems).catch(() => setItems([]));
  }, [doc]);
  if (!items) return <p className="muted small pad">読み込み中…</p>;
  if (items.length === 0) return <p className="muted small pad">この PDF には目次情報がありません。よく使うページには🔖しおりを挟んでおくと便利です。</p>;
  const render = (list: OutlineItem[], depth: number) => (
    <ul className="outline">
      {list.map((it, i) => (
        <li key={i}>
          <button style={{ paddingLeft: 8 + depth * 12 }} disabled={!it.page} onClick={() => it.page && onGo(it.page)}>
            <span>{it.title}</span>
            {it.page && <small className="muted">{it.page}</small>}
          </button>
          {it.items.length > 0 && render(it.items, depth + 1)}
        </li>
      ))}
    </ul>
  );
  return render(items, 0);
}

function Bookmarks({ bookId, page, onGo }: { bookId: string; page: number; onGo: (p: number) => void }) {
  const marks = useLiveQuery(() => db.bookmarks.where('bookId').equals(bookId).sortBy('page'), [bookId]) ?? [];
  if (marks.length === 0) return <p className="muted small pad">ツールバーの 🔖 で今のページ（p.{page}）にしおりを挟めます。</p>;
  return (
    <ul className="outline">
      {marks.map((m) => (
        <li key={m.id} className="bookmark-item">
          <button onClick={() => onGo(m.page)}>
            <span>🔖 {m.label || `p.${m.page}`}</span>
            <small className="muted">{m.page}</small>
          </button>
          <button className="icon-btn tiny" onClick={() => db.bookmarks.delete(m.id)} title="しおりを外す" aria-label="しおりを外す">✕</button>
        </li>
      ))}
    </ul>
  );
}

function Search({ doc, onGo }: { doc: PDFDocumentProxy; onGo: (p: number) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ page: number; snippet: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const query = q.trim().toLowerCase();
    if (!query) return setResults(null);
    setBusy(true);
    const texts = await getAllText(doc);
    const out: { page: number; snippet: string }[] = [];
    texts.forEach((t, i) => {
      const lower = t.toLowerCase();
      let idx = lower.indexOf(query);
      let n = 0;
      while (idx >= 0 && n < 3) {
        out.push({ page: i + 1, snippet: t.slice(Math.max(0, idx - 24), idx + query.length + 36).replace(/\s+/g, ' ') });
        idx = lower.indexOf(query, idx + query.length);
        n++;
      }
    });
    setResults(out);
    setBusy(false);
  };
  return (
    <div>
      <div className="pad">
        <input className="search-input" autoFocus placeholder="参考書の中を検索（Enter）" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && run()} />
      </div>
      {busy && <p className="muted small pad">検索中…（初回は少し時間がかかります）</p>}
      {results && !busy && <p className="muted small pad">{results.length} 件</p>}
      <ul className="outline">
        {results?.map((r, i) => (
          <li key={i}>
            <button onClick={() => onGo(r.page)}>
              <span className="snippet">{highlight(r.snippet, q.trim())}</span>
              <small className="muted">{r.page}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function highlight(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
