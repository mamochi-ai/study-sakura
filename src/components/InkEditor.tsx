import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createReview, db, REVIEW_STATUS, uid, type InkItem, type Note, type Stroke } from '../db';
import { formatDate } from '../lib/format';
import { markerByInkColor, MARKERS, RED_PENS } from '../lib/memorize';
import { getSettings, useSettings } from '../lib/settings';
import { shortTitle, useStudyBus } from '../views/studyBus';
import { MemorizeControls } from './Memorize';
import { askText, toast } from './Modal';
import { notePaper, PaperPicker } from './PaperPicker';
import { openReview } from './Review';

/* 論理座標：用紙の幅を 1000 とする。画面の幅や分割比率が変わっても筆跡は変形しない */
const W = 1000;
/** 描画を分割するタイルの高さ（論理座標）。巨大な Canvas を作らないため */
const TILE = 1000;
const MIN_HEIGHT = 1414;
/** 1 枚のタイルの画素数の上限（拡大しても iPad のメモリを使いすぎないように） */
const MAX_TILE_PX = 5_000_000;
/** ピンチでの拡大率（用紙の幅に合わせた大きさが 1） */
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 3;
const ERASER_R = 10;
/** 指で触れてから動いた距離がこれ以下なら「タップ」とみなす（px） */
const TAP_SLOP = 8;

type Tool = 'pen' | 'marker' | 'eraser' | 'select' | 'flag';
type EraserMode = 'stroke' | 'partial';

const PEN_COLORS = ['#222222', '#d32f2f', '#1565c0', '#2e7d32', '#ef6c00', '#7b1fa2'];
const MARKER_COLORS = MARKERS.map((m) => m.ink);
const PEN_WIDTHS = [2, 3.5, 6];
const MARKER_WIDTHS = [14, 24];

interface Prefs {
  tool: Tool;
  eraserMode: EraserMode;
  penColor: string;
  markerColor: string;
  penWidth: number;
  markerWidth: number;
}
const DEFAULT_PREFS: Prefs = { tool: 'pen', eraserMode: 'stroke', penColor: PEN_COLORS[0], markerColor: MARKER_COLORS[0], penWidth: PEN_WIDTHS[0], markerWidth: MARKER_WIDTHS[0] };
const PREF_KEY = 'study-sakura:ink-tools';
function loadPrefs(): Prefs {
  try {
    const p = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') };
    if (p.tool === 'flag') p.tool = 'pen';
    return p;
  } catch {
    return DEFAULT_PREFS;
  }
}

/** 元に戻す単位。移動は「古いものを消して新しいものを置く」で表す */
interface Op {
  addS: Stroke[];
  remS: Stroke[];
  addI: InkItem[];
  remI: InkItem[];
}

type Box = { x0: number; y0: number; x1: number; y1: number };

function bboxOf(s: Stroke): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.points.length; i += 3) {
    const x = s.points[i], y = s.points[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const m = s.width;
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 点 (x, y) から半径 r 以内を通るか */
function strokeHits(s: Stroke, x: number, y: number, r: number) {
  const p = s.points;
  const rr = r + s.width / 2;
  if (p.length === 3) return Math.hypot(p[0] - x, p[1] - y) <= rr;
  for (let i = 3; i < p.length; i += 3) if (distToSegment(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= rr) return true;
  return false;
}

/** ほとんど動いていない線（ペンで軽くタップしただけ） */
function isTiny(s: Stroke) {
  const p = s.points;
  let x0 = p[0], x1 = p[0], y0 = p[1], y1 = p[1];
  for (let i = 3; i < p.length; i += 3) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
  }
  return x1 - x0 < 10 && y1 - y0 < 10;
}

const hasPressure = (s: Stroke) => {
  for (let i = 2; i < s.points.length; i += 3) if (s.points[i] !== 0.5) return true;
  return false;
};
const pressureFactor = (s: Stroke, pr: number) => (s.tool === 'pen' ? 0.45 + pr * 1.1 : 1);

/** 1 画を描く（ctx は論理座標に変換済み）。cover は暗記シートで隠すときの塗りつぶし */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, cover = false) {
  const p = s.points;
  const n = p.length / 3;
  if (n === 0) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (cover) {
    // 赤ペンは太い赤帯、マーカーは不透明にして下の文字ごと隠す
    const red = s.tool === 'pen';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = ctx.fillStyle = red ? '#c62828' : s.color;
    ctx.lineWidth = red ? Math.max(18, s.width * 5) : s.width + 4;
  } else {
    ctx.strokeStyle = ctx.fillStyle = s.color;
    if (s.tool === 'marker') {
      ctx.globalAlpha = 0.4;
      ctx.globalCompositeOperation = 'multiply';
    } else {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], (cover ? ctx.lineWidth : s.width * pressureFactor(s, p[2])) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const varying = !cover && s.tool === 'pen' && hasPressure(s);
  if (!varying) {
    if (!cover) ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], (p[i * 3] + p[(i + 1) * 3]) / 2, (p[i * 3 + 1] + p[(i + 1) * 3 + 1]) / 2);
    }
    ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    ctx.stroke();
    return;
  }
  // 筆圧で太さが変わる線は、区間ごとに描く
  let px = p[0], py = p[1];
  for (let i = 1; i < n; i++) {
    const last = i === n - 1;
    const mx = last ? p[i * 3] : (p[i * 3] + p[(i + 1) * 3]) / 2;
    const my = last ? p[i * 3 + 1] : (p[i * 3 + 1] + p[(i + 1) * 3 + 1]) / 2;
    ctx.lineWidth = s.width * pressureFactor(s, p[i * 3 + 2]);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], mx, my);
    ctx.stroke();
    px = mx;
    py = my;
  }
}

/** 暗記シートで隠す線か */
function isHidden(s: Stroke) {
  const st = getSettings();
  if (s.tool === 'pen') return st.hideRed && RED_PENS.includes(s.color);
  const m = markerByInkColor(s.color);
  return !!m && st.hideMarkers.includes(m);
}

export default function InkEditor({ note }: { note: Note }) {
  const bus = useStudyBus();
  const settings = useSettings();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [loaded, setLoaded] = useState(false);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [scale, setScale] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [items, setItems] = useState<InkItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [memorize, setMemorize] = useState(false);
  const [, setHistoryTick] = useState(0);

  const reviews = useLiveQuery(() => db.reviews.where('noteId').equals(note.id).toArray(), [note.id]) ?? [];

  const scrollRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef<HTMLDivElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const boxes = useRef(new Map<string, Box>());
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const dirty = useRef(new Set<number>());
  const live = useRef<{ stroke: Stroke; pointerId: number } | null>(null);
  const erasing = useRef<{ pointerId: number; removed: Map<string, Stroke>; added: Map<string, Stroke> } | null>(null);
  const dragging = useRef<{ pointerId: number; mode: 'move' | 'resize'; orig: InkItem; x0: number; y0: number } | null>(null);
  const tap = useRef<{ pointerId: number; cx: number; cy: number } | null>(null);
  const revealed = useRef(new Set<string>());
  const undoStack = useRef<Op[]>([]);
  const redoStack = useRef<Op[]>([]);

  // イベント処理から最新の値を読むための参照
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const zoomRef = useRef(1);
  const baseScale = useRef(0);
  /** ピンチ後に、指の間にあった点を同じ場所に保つための情報 */
  const zoomAnchor = useRef<{ lx: number; ly: number; cx: number; cy: number } | null>(null);
  const heightRef = useRef(height);
  heightRef.current = height;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const memorizeRef = useRef(memorize);
  memorizeRef.current = memorize;
  // 指で書く機能は使われないのでやめた（指はスクロール・ピンチ専用）
  const fingerDraw = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs, tool: prefs.tool === 'flag' ? 'pen' : prefs.tool }));
    } catch {
      /* noop */
    }
  }, [prefs]);
  const set = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));

  /* ---------- 保存 ---------- */
  const persist = useCallback(
    async (fn: () => Promise<unknown>) => {
      setStatus('saving');
      try {
        await fn();
        await db.notes.update(note.id, { updatedAt: Date.now() });
        setStatus('saved');
      } catch (e) {
        setStatus('error');
        toast(`保存できませんでした：${(e as Error).message}`);
      }
    },
    [note.id],
  );

  /* ---------- 読み込み ---------- */
  useEffect(() => {
    let alive = true;
    Promise.all([db.strokes.where('noteId').equals(note.id).sortBy('createdAt'), db.inkItems.where('noteId').equals(note.id).toArray()]).then(([list, its]) => {
      if (!alive) return;
      strokes.current = list;
      let maxY = 0;
      for (const s of list) {
        const b = bboxOf(s);
        boxes.current.set(s.id, b);
        maxY = Math.max(maxY, b.y1);
      }
      for (const it of its) maxY = Math.max(maxY, it.y + (it.h ?? 60));
      setItems(its);
      setHeight(Math.max(MIN_HEIGHT, Math.ceil((maxY + 700) / TILE) * TILE));
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [note.id]);

  const growTo = (y: number) => {
    if (y > heightRef.current - 500) setHeight(Math.ceil((y + 700) / TILE) * TILE);
  };

  /* ---------- タイルの描画 ---------- */
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  /** 拡大すると 1 枚のタイルが大きくなるので、画素数が上限を超えないよう解像度を下げる */
  const tileDpr = (sc: number) => Math.min(dpr, Math.sqrt(MAX_TILE_PX / (W * sc * TILE * sc)));

  const paintTile = useCallback(
    (i: number, extra?: Stroke) => {
      const c = canvases.current.get(i);
      const sc = scaleRef.current;
      if (!c || !sc) return;
      const ctx = c.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      const d = tileDpr(sc);
      ctx.setTransform(d * sc, 0, 0, d * sc, 0, -i * TILE * d * sc);
      const top = i * TILE, bottom = top + TILE;
      const list = extra ? [...strokes.current, extra] : strokes.current;
      const covers: Stroke[] = [];
      for (const s of list) {
        const b = s === extra ? bboxOf(s) : boxes.current.get(s.id);
        if (!b || b.y1 < top || b.y0 > bottom) continue;
        if (memorizeRef.current && !revealed.current.has(s.id) && isHidden(s)) covers.push(s);
        else drawStroke(ctx, s);
      }
      // 隠すものは最後に重ねて、下の文字ごと覆う
      for (const s of covers) drawStroke(ctx, s, true);
    },
    [dpr],
  );

  /** 画面に見えている範囲のタイルだけを作る */
  const updateTiles = useCallback(() => {
    const scroller = scrollRef.current, holder = tilesRef.current, paper = paperRef.current;
    const sc = scaleRef.current;
    if (!scroller || !holder || !paper || !sc) return;
    const viewTop = (scroller.scrollTop - paper.offsetTop) / sc;
    const viewBottom = viewTop + scroller.clientHeight / sc;
    const first = Math.max(0, Math.floor((viewTop - TILE / 2) / TILE));
    const last = Math.min(Math.ceil(heightRef.current / TILE) - 1, Math.floor((viewBottom + TILE / 2) / TILE));
    for (const [i, c] of canvases.current) {
      if (i < first || i > last) {
        c.remove();
        canvases.current.delete(i);
      }
    }
    const cssW = W * sc, cssH = TILE * sc;
    for (let i = first; i <= last; i++) {
      if (canvases.current.has(i)) continue;
      const c = document.createElement('canvas');
      const d = tileDpr(sc);
      c.width = Math.round(cssW * d);
      c.height = Math.round(cssH * d);
      c.style.cssText = `position:absolute;left:0;top:${i * cssH}px;width:${cssW}px;height:${cssH}px`;
      holder.appendChild(c);
      canvases.current.set(i, c);
      paintTile(i);
    }
  }, [dpr, paintTile]);

  const repaintAll = useCallback(() => {
    for (const c of canvases.current.values()) c.remove();
    canvases.current.clear();
    updateTiles();
  }, [updateTiles]);

  // 幅に合わせて拡大率を決める
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      baseScale.current = Math.max(0.2, (el.clientWidth - 32) / W);
      const next = baseScale.current * zoomRef.current;
      const prev = scaleRef.current;
      if (Math.abs(next - prev) < 0.001) return;
      scaleRef.current = next;
      setScale(next);
      if (prev) el.scrollTop *= next / prev;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** 拡大率を変える（ピンチ・リセット） */
  const applyZoom = useCallback((z: number) => {
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    zoomRef.current = nz;
    setZoom(nz);
    const next = baseScale.current * nz;
    scaleRef.current = next;
    setScale(next);
  }, []);

  useLayoutEffect(() => {
    // ピンチした指の位置にあった点が、同じ場所に残るようにスクロールを合わせる
    const a = zoomAnchor.current;
    const scroller = scrollRef.current, paper = paperRef.current;
    if (a && scroller && paper) {
      zoomAnchor.current = null;
      const r = paper.getBoundingClientRect();
      scroller.scrollLeft += r.left + a.lx * scale - a.cx;
      scroller.scrollTop += r.top + a.ly * scale - a.cy;
    }
    if (loaded && scale) repaintAll();
  }, [loaded, scale, height, memorize, settings.hideRed, settings.hideMarkers, repaintAll]);

  const rafId = useRef(0);
  const scheduleDirty = useCallback(() => {
    if (rafId.current) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = 0;
      for (const i of dirty.current) paintTile(i, live.current?.stroke);
      dirty.current.clear();
    });
  }, [paintTile]);
  const markTiles = (y0: number, y1: number) => {
    for (let i = Math.floor(y0 / TILE); i <= Math.floor(y1 / TILE); i++) dirty.current.add(i);
  };

  /* ---------- 元に戻す / やり直す ---------- */
  const applyOp = useCallback(
    (op: Op, reverse: boolean) => {
      const remS = reverse ? op.addS : op.remS, addS = reverse ? op.remS : op.addS;
      const remI = reverse ? op.addI : op.remI, addI = reverse ? op.remI : op.addI;
      const remIds = new Set(remS.map((s) => s.id));
      strokes.current = strokes.current.filter((s) => !remIds.has(s.id));
      for (const s of remS) {
        const b = boxes.current.get(s.id);
        if (b) markTiles(b.y0, b.y1);
        boxes.current.delete(s.id);
      }
      for (const s of addS) {
        const b = bboxOf(s);
        strokes.current.push(s);
        boxes.current.set(s.id, b);
        markTiles(b.y0, b.y1);
      }
      if (addS.length) strokes.current.sort((a, b) => a.createdAt - b.createdAt);
      if (remI.length || addI.length) {
        const remItemIds = new Set(remI.map((i) => i.id));
        setItems((list) => [...list.filter((i) => !remItemIds.has(i.id)), ...addI]);
      }
      scheduleDirty();
      persist(() =>
        db.transaction('rw', db.strokes, db.inkItems, async () => {
          if (remS.length) await db.strokes.bulkDelete(remS.map((s) => s.id));
          if (remI.length) await db.inkItems.bulkDelete(remI.map((i) => i.id));
          if (addS.length) await db.strokes.bulkPut(addS);
          if (addI.length) await db.inkItems.bulkPut(addI);
        }),
      );
    },
    [persist, scheduleDirty],
  );

  const commit = useCallback(
    (op: Partial<Op>) => {
      const full: Op = { addS: [], remS: [], addI: [], remI: [], ...op };
      applyOp(full, false);
      undoStack.current.push(full);
      redoStack.current = [];
      setHistoryTick((t) => t + 1);
    },
    [applyOp],
  );
  const undo = () => {
    const op = undoStack.current.pop();
    if (!op) return;
    applyOp(op, true);
    redoStack.current.push(op);
    setHistoryTick((t) => t + 1);
  };
  const redo = () => {
    const op = redoStack.current.pop();
    if (!op) return;
    applyOp(op, false);
    undoStack.current.push(op);
    setHistoryTick((t) => t + 1);
  };

  /* ---------- 参考書からの差し込み（切り取り・引用・ページリンク） ---------- */
  const visibleTop = () => {
    const scroller = scrollRef.current, paper = paperRef.current, sc = scaleRef.current;
    if (!scroller || !paper || !sc) return 60;
    return Math.max(40, (scroller.scrollTop - paper.offsetTop) / sc + 60);
  };
  const place = (item: Omit<InkItem, 'id' | 'noteId' | 'createdAt' | 'x' | 'y'>, hint = true) => {
    const it: InkItem = { ...item, id: uid(), noteId: note.id, x: 40, y: visibleTop(), createdAt: Date.now() };
    commit({ addI: [it] });
    growTo(it.y + (it.h ?? 120));
    setSelectedId(it.id);
    set({ tool: 'select' });
    if (hint) toast('✋ 選択ツールで動かせます。書くときは ✒️ に戻してください');
    return it;
  };
  const label = (bookId: string) => shortTitle(bus.current.bookTitle(bookId));

  useEffect(() => {
    bus.current.ink = {
      image: (src, bookId, page) => {
        const img = new Image();
        img.onload = () => {
          // 切り取り画像は画面の約 2 倍の解像度なので、PDF 上で見えていた大きさに近づける
          const w = Math.min(W - 80, Math.max(240, img.naturalWidth / 2 / (scaleRef.current || 1)));
          place({ kind: 'image', src, w, h: (w * img.naturalHeight) / img.naturalWidth, bookId, page, label: label(bookId) });
        };
        img.src = src;
      },
      quote: (text, bookId, page) => place({ kind: 'quote', text: text.replace(/\s*\n\s*/g, ' ').trim(), w: 600, bookId, page, label: label(bookId) }),
      pageRef: (bookId, page) => place({ kind: 'pageRef', bookId, page, label: label(bookId) }),
    };
    return () => {
      bus.current.ink = null;
    };
  });

  const placeFlag = async (x: number, y: number) => {
    set({ tool: 'pen' });
    const memo = await askText({ title: '🚩 復習マーク', label: 'メモ（任意）：何が分からないか など', value: '' });
    if (memo === null) return;
    const cur = bus.current.current();
    const review = await createReview({ binderId: bus.current.binderId, noteId: note.id, bookId: cur?.bookId, page: cur?.page, y, memo: memo.trim() });
    const it: InkItem = { id: uid(), noteId: note.id, kind: 'mark', x: Math.max(0, x - 14), y: Math.max(0, y - 14), reviewId: review.id, createdAt: Date.now() };
    setItems((l) => [...l, it]);
    persist(() => db.inkItems.add(it));
    toast('復習マークを付けました（上の 🚩 一覧から確認できます）');
  };

  /* ---------- 入力 ---------- */
  const toLogical = (e: { clientX: number; clientY: number }) => {
    const r = paperRef.current!.getBoundingClientRect();
    const sc = scaleRef.current;
    return { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
  };

  /** 今描いている線の新しい区間だけを描く（ペン） */
  const drawLiveSegment = (s: Stroke) => {
    const p = s.points;
    const n = p.length / 3;
    if (n < 2) return;
    const i = n - 1;
    const ax = n >= 3 ? (p[(i - 2) * 3] + p[(i - 1) * 3]) / 2 : p[0];
    const ay = n >= 3 ? (p[(i - 2) * 3 + 1] + p[(i - 1) * 3 + 1]) / 2 : p[1];
    const cx = p[(i - 1) * 3], cy = p[(i - 1) * 3 + 1];
    const bx = (cx + p[i * 3]) / 2, by = (cy + p[i * 3 + 1]) / 2;
    const w = s.width * pressureFactor(s, p[i * 3 + 2]);
    const y0 = Math.min(ay, cy, by) - w, y1 = Math.max(ay, cy, by) + w;
    const sc = scaleRef.current;
    for (let t = Math.floor(y0 / TILE); t <= Math.floor(y1 / TILE); t++) {
      const c = canvases.current.get(t);
      if (!c) continue;
      const ctx = c.getContext('2d')!;
      const d = tileDpr(sc);
      ctx.setTransform(d * sc, 0, 0, d * sc, 0, -t * TILE * d * sc);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = s.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cx, cy, bx, by);
      ctx.stroke();
    }
  };

  /** 消しゴム：線ごと消す / なぞったところだけ消す */
  const eraseAt = (x: number, y: number) => {
    const g = erasing.current;
    if (!g) return;
    const partial = prefsRef.current.eraserMode === 'partial';
    const hit = strokes.current.filter((s) => {
      const b = boxes.current.get(s.id)!;
      if (x < b.x0 - ERASER_R || x > b.x1 + ERASER_R || y < b.y0 - ERASER_R || y > b.y1 + ERASER_R) return false;
      return strokeHits(s, x, y, ERASER_R);
    });
    if (!hit.length) return;
    const ids = new Set(hit.map((s) => s.id));
    strokes.current = strokes.current.filter((s) => !ids.has(s.id));
    for (const s of hit) {
      const b = boxes.current.get(s.id)!;
      markTiles(b.y0, b.y1);
      boxes.current.delete(s.id);
      if (g.added.has(s.id)) g.added.delete(s.id);
      else g.removed.set(s.id, s);
      if (!partial) continue;
      // 消しゴムの円の外に残る部分を、別々の線として残す
      const p = s.points;
      const rr = ERASER_R + s.width / 2;
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 6) {
          const piece: Stroke = { ...s, id: uid(), points: run, createdAt: s.createdAt + Math.random() * 1e-3 };
          strokes.current.push(piece);
          boxes.current.set(piece.id, bboxOf(piece));
          g.added.set(piece.id, piece);
        }
        run = [];
      };
      for (let i = 0; i < p.length; i += 3) {
        if (Math.hypot(p[i] - x, p[i + 1] - y) <= rr) flush();
        else run.push(p[i], p[i + 1], p[i + 2]);
      }
      flush();
    }
    strokes.current.sort((a, b) => a.createdAt - b.createdAt);
    scheduleDirty();
  };

  /** 暗記シート中のタップ：近くの隠れた線のまとまりを表示 / 再び隠す */
  const toggleReveal = (x: number, y: number) => {
    const hidden = strokes.current.filter(isHidden);
    const first = hidden.find((s) => strokeHits(s, x, y, 14));
    if (!first) return false;
    const group = new Set([first]);
    const queue = [first];
    const GAP = 24;
    while (queue.length) {
      const b = boxes.current.get(queue.pop()!.id)!;
      for (const s of hidden) {
        if (group.has(s)) continue;
        const o = boxes.current.get(s.id)!;
        if (o.x0 <= b.x1 + GAP && o.x1 >= b.x0 - GAP && o.y0 <= b.y1 + GAP && o.y1 >= b.y0 - GAP) {
          group.add(s);
          queue.push(s);
        }
      }
    }
    const show = !revealed.current.has(first.id);
    for (const s of group) {
      if (show) revealed.current.add(s.id);
      else revealed.current.delete(s.id);
      const b = boxes.current.get(s.id)!;
      markTiles(b.y0, b.y1);
    }
    scheduleDirty();
    return true;
  };

  /** タップした場所のボタン（ページリンク・復習マーク）を実行 */
  const runTapAction = (clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-action]');
    if (el?.dataset.action === 'page') {
      bus.current.openPage(el.dataset.bookId!, Number(el.dataset.page));
      return true;
    }
    if (el?.dataset.action === 'review') {
      openReview(el.dataset.reviewId!);
      return true;
    }
    return false;
  };

  /** 指 / ペン / マウスの「タップ」（ほとんど動かさずに離した） */
  const onTap = (clientX: number, clientY: number) => {
    if (runTapAction(clientX, clientY)) return;
    const { x, y } = toLogical({ clientX, clientY });
    if (memorizeRef.current) toggleReveal(x, y);
    else if (prefsRef.current.tool === 'flag') placeFlag(x, y);
    else if (prefsRef.current.tool === 'select') setSelectedId(null);
  };

  /** 書きかけの線を確定する（線が途中で途切れたときも次の線を書けるように） */
  const finishStroke = () => {
    const l = live.current;
    if (!l) return;
    live.current = null;
    const s = l.stroke;
    commit({ addS: [s] });
    growTo(bboxOf(s).y1);
  };

  useEffect(() => {
    const paper = paperRef.current;
    const scroller = scrollRef.current;
    if (!paper || !scroller) return;

    // Apple Pencil を使ったら、指（手のひら）では書かない
    const drawsWith = (e: PointerEvent) => e.pointerType === 'pen' || e.pointerType === 'mouse' || (e.pointerType === 'touch' && fingerDraw.current && !penSeen);
    let claimedByPointer = false;
    /* 手のひらを置いて書いたときの誤動作を防ぐための状態 */
    let penDown = false;
    let penSeen = false;
    let lastPen = 0;
    let blocked = false; // 指をすべて離すまでスクロールしない

    const onDown = (e: PointerEvent) => {
      const tool = prefsRef.current.tool;
      const target = e.target as HTMLElement;
      const itemEl = target.closest<HTMLElement>('[data-item-id]');
      // 選択ツールでは、指でも画像などを動かせる
      const selectTouch = e.pointerType === 'touch' && tool === 'select' && (itemEl || target.closest('[data-handle]'));
      if (!drawsWith(e) && !selectTouch) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      claimedByPointer = true;
      if (e.pointerType === 'pen') {
        penDown = true;
        penSeen = true;
        lastPen = performance.now();
        cancelPan();
      }
      if (live.current) finishStroke();
      if (erasing.current) endErase();
      try {
        paper.setPointerCapture(e.pointerId);
      } catch {
        // 掴めなくても書けるようにする
      }
      tap.current = { pointerId: e.pointerId, cx: e.clientX, cy: e.clientY };
      const { x, y } = toLogical(e);

      if (memorizeRef.current || tool === 'flag') return; // 離したときにタップとして処理
      if (tool === 'select') {
        const del = target.closest<HTMLElement>('[data-delete]');
        if (del) {
          tap.current = null;
          deleteItem(del.dataset.delete!);
          return;
        }
        const handle = target.closest<HTMLElement>('[data-handle]');
        const id = handle?.dataset.handle ?? itemEl?.dataset.itemId;
        const it = id ? itemsRef.current.find((i) => i.id === id) : undefined;
        if (!it) return;
        setSelectedId(it.id);
        dragging.current = { pointerId: e.pointerId, mode: handle ? 'resize' : 'move', orig: it, x0: x, y0: y };
        return;
      }
      if (tool === 'eraser') {
        erasing.current = { pointerId: e.pointerId, removed: new Map(), added: new Map() };
        eraseAt(x, y);
        return;
      }
      const p = prefsRef.current;
      const marker = tool === 'marker';
      live.current = {
        pointerId: e.pointerId,
        stroke: {
          id: uid(),
          noteId: note.id,
          tool: marker ? 'marker' : 'pen',
          color: marker ? p.markerColor : p.penColor,
          width: marker ? p.markerWidth : p.penWidth,
          points: [x, y, e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5],
          createdAt: Date.now(),
        },
      };
    };

    const onMove = (e: PointerEvent) => {
      if (tap.current?.pointerId === e.pointerId && Math.hypot(e.clientX - tap.current.cx, e.clientY - tap.current.cy) > TAP_SLOP) tap.current = null;
      const d = dragging.current;
      if (d && d.pointerId === e.pointerId) {
        e.preventDefault();
        const { x, y } = toLogical(e);
        const dx = x - d.x0, dy = y - d.y0;
        const o = d.orig;
        const next: InkItem =
          d.mode === 'move'
            ? { ...o, x: Math.max(0, Math.min(W - 40, o.x + dx)), y: Math.max(0, o.y + dy) }
            : (() => {
                const w = Math.max(80, Math.min(W - o.x, (o.w ?? 200) + dx));
                return { ...o, w, h: o.h ? (o.h * w) / (o.w ?? w) : undefined };
              })();
        setItems((l) => l.map((i) => (i.id === o.id ? next : i)));
        return;
      }
      const events = e.getCoalescedEvents?.() ?? [];
      const all = events.length ? events : [e];
      if (erasing.current?.pointerId === e.pointerId) {
        e.preventDefault();
        for (const ev of all) {
          const { x, y } = toLogical(ev);
          eraseAt(x, y);
        }
        return;
      }
      const l = live.current;
      if (!l || l.pointerId !== e.pointerId) return;
      e.preventDefault();
      // 速く書いても線が欠けないよう、間の点もすべて使う
      for (const ev of all) {
        const { x, y } = toLogical(ev);
        const p = l.stroke.points;
        const lx = p[p.length - 3], ly = p[p.length - 2];
        if (Math.hypot(x - lx, y - ly) < 0.6) continue;
        p.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, ev.pointerType === 'pen' ? Math.round((ev.pressure || 0.5) * 100) / 100 : 0.5);
        if (l.stroke.tool === 'pen') drawLiveSegment(l.stroke);
        else {
          markTiles(Math.min(y, ly) - l.stroke.width, Math.max(y, ly) + l.stroke.width);
          scheduleDirty();
        }
      }
    };

    const endErase = () => {
      const g = erasing.current;
      erasing.current = null;
      if (g && (g.removed.size || g.added.size)) {
        // eraseAt で画面上はもう消えているので、記録と保存だけ行う
        const op: Op = { addS: [...g.added.values()], remS: [...g.removed.values()], addI: [], remI: [] };
        undoStack.current.push(op);
        redoStack.current = [];
        setHistoryTick((t) => t + 1);
        persist(() =>
          db.transaction('rw', db.strokes, async () => {
            await db.strokes.bulkDelete(op.remS.map((s) => s.id));
            if (op.addS.length) await db.strokes.bulkPut(op.addS);
          }),
        );
      }
    };

    const onUp = (e: PointerEvent) => {
      claimedByPointer = false;
      if (e.pointerType === 'pen') {
        penDown = false;
        lastPen = performance.now();
      }
      const t = tap.current?.pointerId === e.pointerId && e.type === 'pointerup' ? tap.current : null;
      tap.current = null;
      const d = dragging.current;
      if (d && d.pointerId === e.pointerId) {
        dragging.current = null;
        const now = itemsRef.current.find((i) => i.id === d.orig.id);
        // 動かさずに 📖 をタップしたときは、参考書のそのページへ
        if (t && now && now.x === d.orig.x && now.y === d.orig.y && now.w === d.orig.w) {
          runTapAction(e.clientX, e.clientY);
          return;
        }
        if (now && (now.x !== d.orig.x || now.y !== d.orig.y || now.w !== d.orig.w)) {
          commit({ remI: [d.orig], addI: [now] });
          growTo(now.y + (now.h ?? 120));
        }
        return;
      }
      if (erasing.current?.pointerId === e.pointerId) {
        endErase();
        return;
      }
      const l = live.current;
      if (l && l.pointerId === e.pointerId) {
        // ページリンクなどの上を軽くタップしただけなら、点は書かずにボタンとして扱う
        if (t && isTiny(l.stroke) && runTapAction(e.clientX, e.clientY)) {
          live.current = null;
          scheduleDirty();
          return;
        }
        finishStroke();
        return;
      }
      if (t) onTap(e.clientX, e.clientY);
    };

    /* 指の操作：iPad の標準スクロールに任せるとペンの線が途切れることがあるので、自前でスクロール・ピンチする */
    type Gesture = {
      kind: 'pan' | 'pinch';
      x: number; y: number; // 開始時の指（2 本なら中点）の位置
      left: number; top: number; // 開始時のスクロール位置
      dist: number; zoom: number; // ピンチ開始時の指の間隔と拡大率
      ox: number; oy: number; // ピンチ開始時の用紙の左上（画面座標）
      f: number; // ピンチ中の倍率
      moved: boolean;
      t0: number;
      samples: { t: number; x: number; y: number }[];
    };
    let g: Gesture | null = null;
    let momentum = 0;
    const stopMomentum = () => cancelAnimationFrame(momentum);
    const mid = (t: TouchList) => {
      const n = Math.min(t.length, 2);
      let x = 0, y = 0;
      for (let i = 0; i < n; i++) {
        x += t[i].clientX;
        y += t[i].clientY;
      }
      return { x: x / n, y: y / n };
    };
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const isStylus = (e: TouchEvent) => Array.from(e.touches).some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus');
    const clearPreview = () => {
      paper.style.transform = '';
      paper.style.transformOrigin = '';
    };

    const begin = (e: TouchEvent, kind: 'pan' | 'pinch') => {
      const m = mid(e.touches);
      const r = paper.getBoundingClientRect();
      g = {
        kind, x: m.x, y: m.y, left: scroller.scrollLeft, top: scroller.scrollTop,
        dist: kind === 'pinch' ? spread(e.touches) : 0, zoom: zoomRef.current, ox: r.left, oy: r.top, f: 1,
        moved: false, t0: performance.now(), samples: [{ t: performance.now(), x: m.x, y: m.y }],
      };
    };

    /** ペンが来たら指の操作は取り消す（手のひらで動いてしまった分も元に戻す） */
    function cancelPan() {
      stopMomentum();
      if (g?.moved) {
        scroller!.scrollLeft = g.left;
        scroller!.scrollTop = g.top;
      }
      clearPreview();
      g = null;
      blocked = true;
    }

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault(); // スクリブル（手書き文字の自動変換）や長押しメニューも防ぐ
      stopMomentum();
      // ペンで書いている間・書いた直後は、指（＝ペンを持つ手の手のひら）では何もしない
      if (isStylus(e) || claimedByPointer || penDown || performance.now() - lastPen < 500) {
        cancelPan();
        return;
      }
      if (blocked) return;
      const n = e.touches.length;
      if (n === 2) {
        if (live.current && fingerDraw.current) {
          // 2 本目の指が来たら、指で書きかけた線はやめてピンチ・スクロールに切り替える
          live.current = null;
          scheduleDirty();
        }
        begin(e, 'pinch');
      } else if (n === 1 && !fingerDraw.current) begin(e, 'pan');
      else if (n > 2) {
        clearPreview();
        g = null;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (!g || blocked) return;
      if (isStylus(e) || penDown) {
        cancelPan();
        return;
      }
      const m = mid(e.touches);
      if (Math.hypot(m.x - g.x, m.y - g.y) > TAP_SLOP) g.moved = true;
      if (g.kind === 'pinch' && e.touches.length >= 2) {
        const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (g.zoom * spread(e.touches)) / g.dist));
        g.f = z / g.zoom;
        if (Math.abs(g.f - 1) > 0.02) g.moved = true;
        // 指を離すまでは見た目だけ拡大（描き直しは離したときに 1 回）
        paper.style.transformOrigin = `${g.x - g.ox}px ${g.y - g.oy}px`;
        paper.style.transform = `translate(${m.x - g.x}px, ${m.y - g.y}px) scale(${g.f})`;
        return;
      }
      // 少し動くまではスクロールしない（手を置いただけで動かないように）
      if (!g.moved) return;
      scroller.scrollLeft = g.left - (m.x - g.x);
      scroller.scrollTop = g.top - (m.y - g.y);
      const now = performance.now();
      g.samples.push({ t: now, x: m.x, y: m.y });
      while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) blocked = false;
      const p = g;
      if (!p) return;
      if (p.kind === 'pinch') {
        if (e.touches.length >= 2) return;
        g = null;
        const ch = e.changedTouches[0];
        const endMid = e.touches.length === 1 ? { x: (e.touches[0].clientX + ch.clientX) / 2, y: (e.touches[0].clientY + ch.clientY) / 2 } : { x: p.x, y: p.y };
        clearPreview();
        if (!p.moved) return;
        // 指の間にあった用紙上の点
        const sc0 = scaleRef.current;
        zoomAnchor.current = { lx: (p.x - p.ox) / sc0, ly: (p.y - p.oy) / sc0, cx: endMid.x, cy: endMid.y };
        if (Math.abs(p.f - 1) > 0.01) applyZoom(p.zoom * p.f);
        else {
          // 拡大率は変わらず 2 本指で動かしただけ
          scroller.scrollLeft -= endMid.x - p.x;
          scroller.scrollTop -= endMid.y - p.y;
          zoomAnchor.current = null;
        }
        return;
      }
      if (e.touches.length > 0) return;
      g = null;
      const ch = e.changedTouches[0];
      if (!p.moved && performance.now() - p.t0 < 500 && !fingerDraw.current) {
        onTap(ch.clientX, ch.clientY);
        return;
      }
      // 指を離したあとも少し滑らせる（慣性スクロール）
      const a = p.samples[0], b = p.samples[p.samples.length - 1];
      const dt0 = b.t - a.t;
      let vx = dt0 > 0 ? (b.x - a.x) / dt0 : 0;
      let vy = dt0 > 0 ? (b.y - a.y) / dt0 : 0;
      let last = performance.now();
      const step = (now: number) => {
        const dt = now - last;
        last = now;
        scroller.scrollLeft -= vx * dt;
        scroller.scrollTop -= vy * dt;
        const k = Math.pow(0.95, dt / 16);
        vx *= k;
        vy *= k;
        if (Math.hypot(vx, vy) > 0.02) momentum = requestAnimationFrame(step);
      };
      if (Math.hypot(vx, vy) > 0.1) momentum = requestAnimationFrame(step);
    };

    paper.addEventListener('pointerdown', onDown);
    paper.addEventListener('pointermove', onMove);
    paper.addEventListener('pointerup', onUp);
    paper.addEventListener('pointercancel', onUp);
    paper.addEventListener('lostpointercapture', onUp);
    paper.addEventListener('touchstart', onTouchStart, { passive: false });
    paper.addEventListener('touchmove', onTouchMove, { passive: false });
    paper.addEventListener('touchend', onTouchEnd);
    paper.addEventListener('touchcancel', onTouchEnd);
    return () => {
      stopMomentum();
      paper.removeEventListener('pointerdown', onDown);
      paper.removeEventListener('pointermove', onMove);
      paper.removeEventListener('pointerup', onUp);
      paper.removeEventListener('pointercancel', onUp);
      paper.removeEventListener('lostpointercapture', onUp);
      paper.removeEventListener('touchstart', onTouchStart);
      paper.removeEventListener('touchmove', onTouchMove);
      paper.removeEventListener('touchend', onTouchEnd);
      paper.removeEventListener('touchcancel', onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, loaded]);

  const deleteItem = (id: string) => {
    const it = itemsRef.current.find((i) => i.id === id);
    if (!it) return;
    setSelectedId(null);
    if (it.kind === 'mark' && it.reviewId) {
      openReview(it.reviewId); // 復習マークは詳細画面から削除する
      return;
    }
    commit({ remI: [it] });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteItem(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (prefs.tool !== 'select') setSelectedId(null);
  }, [prefs.tool]);

  const rename = async () => {
    const t = await askText({ title: 'ノートの名前', value: note.title });
    if (t?.trim()) persist(() => db.notes.update(note.id, { title: t.trim() }));
  };

  const colors = prefs.tool === 'marker' ? MARKER_COLORS : PEN_COLORS;
  const widths = prefs.tool === 'marker' ? MARKER_WIDTHS : PEN_WIDTHS;
  const curColor = prefs.tool === 'marker' ? prefs.markerColor : prefs.penColor;
  const curWidth = prefs.tool === 'marker' ? prefs.markerWidth : prefs.penWidth;
  const statusOf = (reviewId?: string) => reviews.find((r) => r.id === reviewId)?.status ?? 'todo';
  const selected = items.find((i) => i.id === selectedId);

  return (
    <div className={`note-editor ink-editor${memorize ? ' memorize' : ''}`}>
      <div className="note-toolbar ink-toolbar" role="toolbar" aria-label="手書きツール" onMouseDown={(e) => (e.target as HTMLElement).closest('button, summary') && e.preventDefault()}>
        <button className="icon-btn" disabled={!undoStack.current.length} onClick={undo} title="元に戻す">↶</button>
        <button className="icon-btn" disabled={!redoStack.current.length} onClick={redo} title="やり直す">↷</button>
        <span className="tb-sep" />
        <button className={`icon-btn tool${prefs.tool === 'pen' ? ' active' : ''}`} onClick={() => set({ tool: 'pen' })} title="ペン">✒️</button>
        <button className={`icon-btn tool${prefs.tool === 'marker' ? ' active' : ''}`} onClick={() => set({ tool: 'marker' })} title="マーカー">🖍</button>
        <details className="menu">
          <summary
            className={`icon-btn tool eraser-btn${prefs.tool === 'eraser' ? ' active' : ''}`}
            title="消しゴム"
            onClick={(e) => {
              // 1 回目のタップで消しゴムに持ち替え、もう 1 回で種類を選ぶ
              if (prefsRef.current.tool !== 'eraser') {
                e.preventDefault();
                set({ tool: 'eraser' });
              }
            }}
          >
            <span className="eraser-icon" aria-hidden />
          </summary>
          <div className="menu-list">
            <div className="menu-caption">消しゴム</div>
            <button className={prefs.eraserMode === 'stroke' ? 'active' : ''} onClick={() => set({ tool: 'eraser', eraserMode: 'stroke' })}>線ごと消す</button>
            <button className={prefs.eraserMode === 'partial' ? 'active' : ''} onClick={() => set({ tool: 'eraser', eraserMode: 'partial' })}>なぞった部分だけ消す</button>
          </div>
        </details>
        <button className={`icon-btn tool${prefs.tool === 'select' ? ' active' : ''}`} onClick={() => set({ tool: 'select' })} title="選択（貼った画像などを動かす・大きさを変える・削除）">✋</button>
        <span className="tb-sep" />
        {/* 色と太さは 1 つのボタンにまとめて、ツールを替えてもツールバーの幅が変わらないようにする */}
        <details className="menu" style={{ visibility: prefs.tool === 'pen' || prefs.tool === 'marker' ? undefined : 'hidden' }}>
          <summary className="icon-btn ink-current" title="色と太さ">
            <span className="ink-swatch" style={{ background: curColor }} />
            <span className="ink-dot" style={{ width: Math.min(16, Math.max(4, curWidth * (prefs.tool === 'marker' ? 0.6 : 2))), height: Math.min(16, Math.max(4, curWidth * (prefs.tool === 'marker' ? 0.6 : 2))) }} />
          </summary>
          <div className="menu-list ink-menu">
            <div className="menu-caption">{prefs.tool === 'marker' ? 'マーカーの色' : 'ペンの色'}</div>
            <div className="swatches">
              {colors.map((c) => (
                <button key={c} className={`ink-color${c === curColor ? ' active' : ''}`} style={{ background: c }} onClick={() => set(prefs.tool === 'marker' ? { markerColor: c } : { penColor: c })} aria-label={`色 ${c}`} />
              ))}
            </div>
            <div className="menu-caption">太さ</div>
            <div className="swatches">
              {widths.map((w) => (
                <button key={w} className={`ink-width${w === curWidth ? ' active' : ''}`} onClick={() => set(prefs.tool === 'marker' ? { markerWidth: w } : { penWidth: w })} aria-label={`太さ ${w}`}>
                  <span style={{ width: Math.max(4, w * (prefs.tool === 'marker' ? 0.7 : 2)), height: Math.max(4, w * (prefs.tool === 'marker' ? 0.7 : 2)), background: curColor }} />
                </button>
              ))}
            </div>
          </div>
        </details>
        <button className={`icon-btn tool${prefs.tool === 'flag' ? ' active' : ''}`} onClick={() => set({ tool: prefs.tool === 'flag' ? 'pen' : 'flag' })} title="復習マーク（押してから、付けたい場所をタップ）">🚩</button>
        <PaperPicker note={note} />
        <span className="tb-spacer" />
        <MemorizeControls
          active={memorize}
          onToggle={() => {
            revealed.current.clear();
            setMemorize(!memorize);
          }}
        />
      </div>
      {memorize && <div className="memorize-banner">暗記シート中：隠れているところをタップすると表示されます（もう一度タップで隠す）。この間は書けません。</div>}
      {prefs.tool === 'select' && (
        <div className="flag-banner select-banner">
          ✋ 選択中：貼り付けた画像・引用・ページリンクを指やペンでドラッグして移動、右下の ○ で大きさ変更、✕ で削除。📖 をタップすると参考書のそのページへ。書くときは ✒️ に戻してください
        </div>
      )}
      {prefs.tool === 'flag' && <div className="flag-banner">🚩 復習マークを付けたい場所をタップしてください</div>}
      <div ref={scrollRef} className="note-scroll ink-scroll" onScroll={updateTiles}>
        {/* タイトルは文字入力欄にしない（ペンで書いたときに iPad のスクリブルが反応しないように） */}
        <div className="ink-titlebar">
          <button className="ink-title-btn" onClick={rename} title="名前を変更">
            {note.title} <span className="muted">✎</span>
          </button>
        </div>
        <div
          ref={paperRef}
          className={`ink-paper paper-${notePaper(note)} tool-${prefs.tool}`}
          style={{ width: W * scale, height: height * scale, '--u': `${scale}px` } as React.CSSProperties}
        >
          <div className="ink-items">
            {items
              .filter((it) => it.kind !== 'mark')
              .map((it) => (
                <InkItemView key={it.id} it={it} scale={scale} />
              ))}
          </div>
          <div ref={tilesRef} className="ink-tiles" />
          <div className="ink-overlay">
            {items
              .filter((it) => it.kind === 'mark')
              .map((it) => {
                const st = statusOf(it.reviewId);
                const r = reviews.find((x) => x.id === it.reviewId);
                return (
                  <button
                    key={it.id}
                    className="ink-mark"
                    data-item-id={it.id}
                    data-action="review"
                    data-review-id={it.reviewId}
                    style={{ left: it.x * scale, top: it.y * scale, '--status-color': REVIEW_STATUS[st].color } as React.CSSProperties}
                    title={r?.memo || '復習マーク'}
                  >
                    🚩{r?.memo && <span className="ink-mark-memo">{r.memo}</span>}
                  </button>
                );
              })}
            {prefs.tool === 'select' && selected && (
              <div
                className="ink-selection"
                style={{
                  left: selected.x * scale - 4,
                  top: selected.y * scale - 4,
                  width: (selected.w ?? 120) * scale + 8,
                  height: selected.h ? selected.h * scale + 8 : undefined,
                }}
              >
                <button className="ink-del" data-delete={selected.id} aria-label="削除">✕</button>
                {(selected.kind === 'image' || selected.kind === 'quote') && <span className="ink-handle" data-handle={selected.id} aria-label="大きさを変える" />}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="note-status">
        <span>
          Pencil で書く・指でスクロール・2本指で拡大縮小
          {Math.abs(zoom - 1) > 0.01 && (
            <button className="zoom-reset" onClick={() => applyZoom(1)} title="用紙の幅に戻す">
              🔍 {Math.round(zoom * 100)}%（戻す）
            </button>
          )}
        </span>
        <span className={status === 'error' ? 'status-error' : ''}>
          {{ saved: `保存済み・${formatDate(note.updatedAt)}`, saving: '保存中…', error: '⚠ 保存に失敗しました' }[status]}
        </span>
      </div>
    </div>
  );
}

/** 手書きノートに貼った画像・引用・ページリンク */
function InkItemView({ it, scale }: { it: InkItem; scale: number }) {
  const ref =
    it.bookId && it.page ? (
      <span className="page-ref" data-action="page" data-book-id={it.bookId} data-page={it.page}>
        📖 {it.label ? `${it.label} ` : ''}p.{it.page}
      </span>
    ) : null;
  const style = { left: it.x * scale, top: it.y * scale, width: it.w ? it.w * scale : undefined, fontSize: 20 * scale } as React.CSSProperties;
  if (it.kind === 'image')
    return (
      <div className="ink-item ink-image" data-item-id={it.id} style={style}>
        <img src={it.src} alt="" style={{ width: '100%', height: it.h ? it.h * scale : undefined }} draggable={false} />
        {ref}
      </div>
    );
  if (it.kind === 'quote')
    return (
      <div className="ink-item ink-quote" data-item-id={it.id} style={style}>
        <p>{it.text}</p>
        {ref}
      </div>
    );
  return (
    <div className="ink-item ink-ref" data-item-id={it.id} style={style}>
      {ref}
    </div>
  );
}
