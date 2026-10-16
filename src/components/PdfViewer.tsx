import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pdfjs, type PDFDocumentProxy } from '../lib/pdf';

export interface PdfViewerHandle {
  goTo: (page: number, smooth?: boolean) => void;
  /** 選択範囲 (ページ内の CSS px) を画像として切り出す */
  capture: (page: number, rect: { x: number; y: number; w: number; h: number }) => Promise<string | null>;
}

interface Props {
  doc: PDFDocumentProxy;
  scale: number;
  initialPage: number;
  captureMode: boolean;
  onPageChange: (page: number) => void;
  onCapture: (page: number, rect: { x: number; y: number; w: number; h: number }) => void;
  onTextSelect: (sel: { text: string; page: number; x: number; y: number } | null) => void;
  onFitWidth: (width: number) => void;
  onCtrlWheel: (deltaY: number) => void;
}

const GAP = 12;

export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { doc, scale, initialPage, captureMode, onPageChange, onCapture, onTextSelect, onFitWidth, onCtrlWheel },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[] | null>(null);
  const pageRef = useRef(initialPage);
  const pendingPage = useRef<number | null>(initialPage);

  // 全ページの大きさを先に取得（スクロール位置の計算に使う）
  useEffect(() => {
    let alive = true;
    (async () => {
      const first = await doc.getPage(1);
      const v = first.getViewport({ scale: 1 });
      if (alive) setSizes(Array.from({ length: doc.numPages }, () => ({ w: v.width, h: v.height })));
      const all = await Promise.all(
        Array.from({ length: doc.numPages }, async (_, i) => {
          const p = await doc.getPage(i + 1);
          const vp = p.getViewport({ scale: 1 });
          return { w: vp.width, h: vp.height };
        }),
      );
      if (alive && all.some((s) => s.w !== v.width || s.h !== v.height)) setSizes(all);
    })();
    return () => {
      alive = false;
    };
  }, [doc]);

  const offsets = useMemo(() => {
    if (!sizes) return [];
    const out: number[] = [];
    let y = GAP;
    for (const s of sizes) {
      out.push(y);
      y += Math.round(s.h * scale) + GAP;
    }
    out.push(y);
    return out;
  }, [sizes, scale]);

  const maxWidth = useMemo(() => (sizes ? Math.max(...sizes.map((s) => s.w)) : 600), [sizes]);

  // 「幅に合わせる」用にコンテナ幅を通知
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onFitWidth((el.clientWidth - 2 * GAP - 4) / maxWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxWidth, onFitWidth]);

  const scrollToPage = useCallback(
    (page: number, smooth = false) => {
      const el = scrollRef.current;
      if (!el || offsets.length === 0) {
        pendingPage.current = page;
        return;
      }
      const p = Math.min(Math.max(1, page), offsets.length - 1);
      el.scrollTo({ top: offsets[p - 1] - GAP, behavior: smooth ? 'smooth' : 'auto' });
    },
    [offsets],
  );

  // 初回表示・拡大率変更後も、同じページを表示し続ける
  const prevOffsets = useRef<number[]>([]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || offsets.length === 0) return;
    if (pendingPage.current !== null) {
      scrollToPage(pendingPage.current);
      pendingPage.current = null;
    } else if (prevOffsets.current.length && prevOffsets.current !== offsets) {
      const prev = prevOffsets.current;
      const p = pageRef.current;
      const prevH = prev[p] - prev[p - 1] || 1;
      const ratio = (el.scrollTop - prev[p - 1]) / prevH;
      el.scrollTop = offsets[p - 1] + ratio * (offsets[p] - offsets[p - 1]);
    }
    prevOffsets.current = offsets;
  }, [offsets, scrollToPage]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || offsets.length === 0) return;
    const probe = el.scrollTop + el.clientHeight * 0.3;
    let lo = 0;
    let hi = offsets.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= probe) lo = mid;
      else hi = mid - 1;
    }
    const page = lo + 1;
    if (page !== pageRef.current) {
      pageRef.current = page;
      onPageChange(page);
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      goTo: (page, smooth) => {
        pageRef.current = page;
        scrollToPage(page, smooth);
      },
      capture: async (page, rect) => {
        // 切り取りは画面より高い解像度で描き直してきれいにする
        const p = await doc.getPage(page);
        const hiScale = Math.max(2, scale * 2);
        const vp = p.getViewport({ scale: hiScale });
        const full = document.createElement('canvas');
        full.width = vp.width;
        full.height = vp.height;
        await p.render({ canvasContext: full.getContext('2d')!, viewport: vp }).promise;
        const k = hiScale / scale;
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(rect.w * k));
        out.height = Math.max(1, Math.round(rect.h * k));
        out.getContext('2d')!.drawImage(full, rect.x * k, rect.y * k, rect.w * k, rect.h * k, 0, 0, out.width, out.height);
        return out.toDataURL('image/png');
      },
    }),
    [doc, scale, scrollToPage],
  );

  // Ctrl + ホイールで拡大縮小
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      onCtrlWheel(e.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onCtrlWheel]);

  // テキスト選択 → 「ノートに引用」ボタン
  const onMouseUp = () => {
    if (captureMode) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!sel || !text || sel.rangeCount === 0 || !scrollRef.current?.contains(sel.anchorNode)) return onTextSelect(null);
      const pageEl = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest<HTMLElement>('[data-page]');
      const r = sel.getRangeAt(0).getBoundingClientRect();
      onTextSelect({ text, page: Number(pageEl?.dataset.page ?? pageRef.current), x: r.left + r.width / 2, y: r.top });
    });
  };

  if (!sizes) return <div className="pdf-scroll"><div className="pdf-loading">読み込み中…</div></div>;

  const contentWidth = Math.round(maxWidth * scale) + GAP * 2;
  return (
    <div
      ref={scrollRef}
      className={`pdf-scroll${captureMode ? ' capture-mode' : ''}`}
      onScroll={onScroll}
      onMouseUp={onMouseUp}
      onMouseDown={() => onTextSelect(null)}
    >
      <div className="pdf-pages" style={{ height: offsets[offsets.length - 1], width: contentWidth }}>
        {sizes.map((s, i) => (
          <PdfPage
            key={i}
            doc={doc}
            pageNumber={i + 1}
            width={Math.round(s.w * scale)}
            height={Math.round(s.h * scale)}
            top={offsets[i]}
            scale={scale}
            root={scrollRef}
            captureMode={captureMode}
            onCapture={onCapture}
          />
        ))}
      </div>
    </div>
  );
});

function PdfPage({
  doc,
  pageNumber,
  width,
  height,
  top,
  scale,
  root,
  captureMode,
  onCapture,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  height: number;
  top: number;
  scale: number;
  root: React.RefObject<HTMLDivElement>;
  captureMode: boolean;
  onCapture: Props['onCapture'];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { root: root.current, rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    // 拡大率を連続で変えたときに描画が詰まらないよう少し待つ
    const timer = setTimeout(async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.className = 'pdf-canvas';
      const ctx = canvas.getContext('2d')!;
      task = page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      try {
        await task.promise;
      } catch {
        return;
      }
      if (cancelled || !canvasRef.current) return;
      // 描画が終わってから差し替えるので、拡大中もチラつかない
      canvasRef.current.replaceChildren(canvas);
      setRendered(true);

      const tl = textRef.current;
      if (tl) {
        tl.replaceChildren();
        textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
        await textLayer.render().catch(() => {});
      }
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
      textLayer?.cancel();
    };
  }, [visible, doc, pageNumber, scale]);

  // 画面から遠く離れたページはメモリを空ける
  useEffect(() => {
    if (visible) return;
    canvasRef.current?.replaceChildren();
    textRef.current?.replaceChildren();
    setRendered(false);
  }, [visible]);

  const toLocal = (e: React.PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: Math.min(Math.max(0, e.clientX - r.left), r.width), y: Math.min(Math.max(0, e.clientY - r.top), r.height) };
  };

  return (
    <div
      ref={wrapRef}
      className="pdf-page"
      data-page={pageNumber}
      style={{ top, width, height, '--scale-factor': scale } as React.CSSProperties}
    >
      <div ref={canvasRef} className="pdf-canvas-holder" />
      {!rendered && <div className="pdf-page-num">{pageNumber}</div>}
      <div ref={textRef} className="textLayer" />
      {captureMode && (
        <div
          className="capture-layer"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = toLocal(e);
            setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          }}
          onPointerMove={(e) => drag && setDrag({ ...drag, ...((p) => ({ x1: p.x, y1: p.y }))(toLocal(e)) })}
          onPointerUp={() => {
            if (!drag) return;
            const rect = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
            setDrag(null);
            if (rect.w > 8 && rect.h > 8) onCapture(pageNumber, rect);
          }}
        >
          {drag && (
            <div
              className="capture-rect"
              style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }}
            />
          )}
        </div>
      )}
    </div>
  );
}
