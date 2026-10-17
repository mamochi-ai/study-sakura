import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { db, uid, type Note, type Stroke } from '../db';
import { formatDate } from '../lib/format';
import { updateSettings, useSettings } from '../lib/settings';
import { toast } from './Modal';
import { notePaper, PaperPicker } from './PaperPicker';

/* 論理座標：用紙の幅を 1000 とする。画面の幅や分割比率が変わっても筆跡は変形しない */
const W = 1000;
/** 描画を分割するタイルの高さ（論理座標）。巨大な Canvas を作らないため */
const TILE = 1000;
const MIN_HEIGHT = 1414;
const ERASER_R = 10;

type Tool = 'pen' | 'marker' | 'eraser';

const PEN_COLORS = ['#222222', '#d32f2f', '#1565c0', '#2e7d32', '#ef6c00', '#7b1fa2'];
const MARKER_COLORS = ['#ffe94d', '#ff8fb1', '#7ee8a2', '#7cc7ff', '#ffb74d'];
const PEN_WIDTHS = [2, 3.5, 6];
const MARKER_WIDTHS = [14, 24];

interface Live {
  stroke: Stroke;
  pointerId: number;
}
type Op = { kind: 'add'; strokes: Stroke[] } | { kind: 'erase'; strokes: Stroke[] };

const PREF_KEY = 'study-sakura:ink-tools';
function loadPrefs() {
  try {
    return { tool: 'pen' as Tool, penColor: PEN_COLORS[0], markerColor: MARKER_COLORS[0], penWidth: PEN_WIDTHS[0], markerWidth: MARKER_WIDTHS[0], ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') };
  } catch {
    return { tool: 'pen' as Tool, penColor: PEN_COLORS[0], markerColor: MARKER_COLORS[0], penWidth: PEN_WIDTHS[0], markerWidth: MARKER_WIDTHS[0] };
  }
}

function bboxOf(s: Stroke) {
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

/** 1 画を描く（ctx は論理座標に変換済み） */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  const p = s.points;
  const n = p.length / 3;
  if (n === 0) return;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'marker') {
    ctx.globalAlpha = 0.4;
    ctx.globalCompositeOperation = 'multiply';
  } else {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], (s.width * pressureFactor(s, p[2])) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const varying = s.tool === 'pen' && hasPressure(s);
  if (!varying) {
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (p[i * 3] + p[(i + 1) * 3]) / 2;
      const my = (p[i * 3 + 1] + p[(i + 1) * 3 + 1]) / 2;
      ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], mx, my);
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

const hasPressure = (s: Stroke) => {
  for (let i = 2; i < s.points.length; i += 3) if (s.points[i] !== 0.5) return true;
  return false;
};
const pressureFactor = (s: Stroke, pr: number) => (s.tool === 'pen' ? 0.45 + pr * 1.1 : 1);

export default function InkEditor({ note }: { note: Note }) {
  const settings = useSettings();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [title, setTitle] = useState(note.title);
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [loaded, setLoaded] = useState(false);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [scale, setScale] = useState(0);
  const [, setHistoryTick] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef<HTMLDivElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const boxes = useRef(new Map<string, ReturnType<typeof bboxOf>>());
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const dirty = useRef(new Set<number>());
  const live = useRef<Live | null>(null);
  const erasing = useRef<Stroke[] | null>(null);
  const undoStack = useRef<Op[]>([]);
  const redoStack = useRef<Op[]>([]);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const heightRef = useRef(height);
  heightRef.current = height;
  const fingerDraw = useRef(settings.fingerDraw);
  fingerDraw.current = settings.fingerDraw;

  useEffect(() => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    } catch {
      /* noop */
    }
  }, [prefs]);

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
    db.strokes
      .where('noteId')
      .equals(note.id)
      .sortBy('createdAt')
      .then((list) => {
        if (!alive) return;
        strokes.current = list;
        let maxY = 0;
        for (const s of list) {
          const b = bboxOf(s);
          boxes.current.set(s.id, b);
          maxY = Math.max(maxY, b.y1);
        }
        setHeight(Math.max(MIN_HEIGHT, Math.ceil((maxY + 700) / TILE) * TILE));
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [note.id]);

  /* ---------- タイルの描画 ---------- */
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const paintTile = useCallback(
    (i: number, extra?: Stroke) => {
      const c = canvases.current.get(i);
      const sc = scaleRef.current;
      if (!c || !sc) return;
      const ctx = c.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(dpr * sc, 0, 0, dpr * sc, 0, -i * TILE * dpr * sc);
      const top = i * TILE, bottom = top + TILE;
      const list = extra ? [...strokes.current, extra] : strokes.current;
      for (const s of list) {
        const b = s === extra ? bboxOf(s) : boxes.current.get(s.id);
        if (!b || b.y1 < top || b.y0 > bottom) continue;
        drawStroke(ctx, s);
      }
    },
    [dpr],
  );

  /** 画面に見えている範囲のタイルだけを作る */
  const updateTiles = useCallback(() => {
    const scroller = scrollRef.current, holder = tilesRef.current, paper = paperRef.current;
    const sc = scaleRef.current;
    if (!scroller || !holder || !paper || !sc) return;
    const offset = paper.offsetTop;
    const viewTop = (scroller.scrollTop - offset) / sc;
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
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
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
      const next = Math.max(0.2, (el.clientWidth - 32) / W);
      const prev = scaleRef.current;
      if (Math.abs(next - prev) < 0.001) return;
      const ratio = prev ? next / prev : 1;
      scaleRef.current = next;
      setScale(next);
      if (prev) el.scrollTop *= ratio;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (loaded && scale) repaintAll();
  }, [loaded, scale, height, repaintAll]);

  const flushDirty = useRef(0);
  const scheduleDirty = useCallback(() => {
    if (flushDirty.current) return;
    flushDirty.current = requestAnimationFrame(() => {
      flushDirty.current = 0;
      for (const i of dirty.current) paintTile(i, live.current?.stroke);
      dirty.current.clear();
    });
  }, [paintTile]);

  const markTiles = (y0: number, y1: number) => {
    for (let i = Math.floor(y0 / TILE); i <= Math.floor(y1 / TILE); i++) dirty.current.add(i);
  };

  /* ---------- 入力 ---------- */
  const toLogical = (e: PointerEvent) => {
    const r = paperRef.current!.getBoundingClientRect();
    const sc = scaleRef.current;
    return { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
  };

  const canDraw = (e: PointerEvent) => e.pointerType === 'pen' || e.pointerType === 'mouse' || (e.pointerType === 'touch' && fingerDraw.current);

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
      ctx.setTransform(dpr * sc, 0, 0, dpr * sc, 0, -t * TILE * dpr * sc);
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

  const eraseAt = (x: number, y: number) => {
    const hit: Stroke[] = [];
    for (const s of strokes.current) {
      const b = boxes.current.get(s.id)!;
      if (x < b.x0 - ERASER_R || x > b.x1 + ERASER_R || y < b.y0 - ERASER_R || y > b.y1 + ERASER_R) continue;
      const p = s.points;
      const r = ERASER_R + s.width / 2;
      let touched = p.length === 3 && Math.hypot(p[0] - x, p[1] - y) <= r;
      for (let i = 3; i < p.length && !touched; i += 3) {
        if (distToSegment(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= r) touched = true;
      }
      if (touched) hit.push(s);
    }
    if (!hit.length) return;
    const ids = new Set(hit.map((s) => s.id));
    strokes.current = strokes.current.filter((s) => !ids.has(s.id));
    for (const s of hit) {
      const b = boxes.current.get(s.id)!;
      markTiles(b.y0, b.y1);
      boxes.current.delete(s.id);
    }
    erasing.current?.push(...hit);
    scheduleDirty();
  };

  useEffect(() => {
    const paper = paperRef.current;
    const scroller = scrollRef.current;
    if (!paper || !scroller) return;

    const onDown = (e: PointerEvent) => {
      if (!canDraw(e) || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (live.current || erasing.current) return;
      e.preventDefault();
      paper.setPointerCapture(e.pointerId);
      const { x, y } = toLogical(e);
      const pr = prefsRef.current;
      if (pr.tool === 'eraser') {
        erasing.current = [];
        eraseAt(x, y);
        return;
      }
      const marker = pr.tool === 'marker';
      live.current = {
        pointerId: e.pointerId,
        stroke: {
          id: uid(),
          noteId: note.id,
          tool: marker ? 'marker' : 'pen',
          color: marker ? pr.markerColor : pr.penColor,
          width: marker ? pr.markerWidth : pr.penWidth,
          points: [x, y, e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5],
          createdAt: Date.now(),
        },
      };
    };

    const onMove = (e: PointerEvent) => {
      if (erasing.current) {
        e.preventDefault();
        const events = e.getCoalescedEvents?.() ?? [e];
        for (const ev of events.length ? events : [e]) {
          const { x, y } = toLogical(ev);
          eraseAt(x, y);
        }
        return;
      }
      const l = live.current;
      if (!l || l.pointerId !== e.pointerId) return;
      e.preventDefault();
      // 速く書いても線が欠けないよう、間の点もすべて使う
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ev of events.length ? events : [e]) {
        const { x, y } = toLogical(ev);
        const p = l.stroke.points;
        const lx = p[p.length - 3], ly = p[p.length - 2];
        if (Math.hypot(x - lx, y - ly) < 0.6) continue;
        p.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, ev.pointerType === 'pen' ? Math.round((ev.pressure || 0.5) * 100) / 100 : 0.5);
        if (l.stroke.tool === 'pen') drawLiveSegment(l.stroke);
        else {
          markTiles(y - l.stroke.width, y + l.stroke.width);
          markTiles(ly - l.stroke.width, ly + l.stroke.width);
          scheduleDirty();
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      if (erasing.current) {
        const erased = erasing.current;
        erasing.current = null;
        if (erased.length) {
          undoStack.current.push({ kind: 'erase', strokes: erased });
          redoStack.current = [];
          setHistoryTick((t) => t + 1);
          persist(() => db.strokes.bulkDelete(erased.map((s) => s.id)));
        }
        return;
      }
      const l = live.current;
      if (!l || l.pointerId !== e.pointerId) return;
      live.current = null;
      const s = l.stroke;
      const b = bboxOf(s);
      strokes.current.push(s);
      boxes.current.set(s.id, b);
      markTiles(b.y0, b.y1);
      scheduleDirty();
      undoStack.current.push({ kind: 'add', strokes: [s] });
      redoStack.current = [];
      setHistoryTick((t) => t + 1);
      persist(() => db.strokes.add(s));
      // 下の方まで書いたら用紙を伸ばす
      if (b.y1 > heightRef.current - 500) setHeight((h) => h + TILE);
    };

    // Apple Pencil で書いている間は画面をスクロールさせない（指のスクロールはそのまま）
    const onTouch = (e: TouchEvent) => {
      const stylus = Array.from(e.touches).some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus');
      if (stylus || (fingerDraw.current && e.touches.length === 1)) e.preventDefault();
    };

    // 「指でも書く」設定のときは、2 本指でスクロールする
    let two: { y: number; top: number } | null = null;
    const onTwoStart = (e: TouchEvent) => {
      if (!fingerDraw.current || e.touches.length !== 2) return;
      live.current = null;
      erasing.current = null;
      scheduleDirty();
      two = { y: (e.touches[0].clientY + e.touches[1].clientY) / 2, top: scroller.scrollTop };
    };
    const onTwoMove = (e: TouchEvent) => {
      if (!two || e.touches.length !== 2) return;
      e.preventDefault();
      scroller.scrollTop = two.top - ((e.touches[0].clientY + e.touches[1].clientY) / 2 - two.y);
    };
    const onTwoEnd = () => (two = null);

    paper.addEventListener('pointerdown', onDown);
    paper.addEventListener('pointermove', onMove);
    paper.addEventListener('pointerup', onUp);
    paper.addEventListener('pointercancel', onUp);
    paper.addEventListener('touchstart', onTouch, { passive: false });
    paper.addEventListener('touchmove', onTouch, { passive: false });
    paper.addEventListener('touchstart', onTwoStart, { passive: true });
    paper.addEventListener('touchmove', onTwoMove, { passive: false });
    paper.addEventListener('touchend', onTwoEnd);
    return () => {
      paper.removeEventListener('pointerdown', onDown);
      paper.removeEventListener('pointermove', onMove);
      paper.removeEventListener('pointerup', onUp);
      paper.removeEventListener('pointercancel', onUp);
      paper.removeEventListener('touchstart', onTouch);
      paper.removeEventListener('touchmove', onTouch);
      paper.removeEventListener('touchstart', onTwoStart);
      paper.removeEventListener('touchmove', onTwoMove);
      paper.removeEventListener('touchend', onTwoEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, loaded]);

  /* ---------- 元に戻す / やり直す ---------- */
  const applyOp = (op: Op, reverse: boolean) => {
    const adding = (op.kind === 'add') !== reverse;
    if (adding) {
      for (const s of op.strokes) {
        strokes.current.push(s);
        boxes.current.set(s.id, bboxOf(s));
      }
      strokes.current.sort((a, b) => a.createdAt - b.createdAt);
      persist(() => db.strokes.bulkPut(op.strokes));
    } else {
      const ids = new Set(op.strokes.map((s) => s.id));
      strokes.current = strokes.current.filter((s) => !ids.has(s.id));
      for (const id of ids) boxes.current.delete(id);
      persist(() => db.strokes.bulkDelete([...ids]));
    }
    for (const s of op.strokes) {
      const b = bboxOf(s);
      markTiles(b.y0, b.y1);
    }
    scheduleDirty();
    setHistoryTick((t) => t + 1);
  };
  const undo = () => {
    const op = undoStack.current.pop();
    if (!op) return;
    applyOp(op, true);
    redoStack.current.push(op);
  };
  const redo = () => {
    const op = redoStack.current.pop();
    if (!op) return;
    applyOp(op, false);
    undoStack.current.push(op);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---------- タイトル ---------- */
  const titleTimer = useRef<ReturnType<typeof setTimeout>>();
  const saveTitle = (t: string) => {
    clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => persist(() => db.notes.update(note.id, { title: t.trim() || '手書きノート' })), 500);
  };

  const set = (patch: Partial<typeof prefs>) => setPrefs((p: typeof prefs) => ({ ...p, ...patch }));
  const colors = prefs.tool === 'marker' ? MARKER_COLORS : PEN_COLORS;
  const widths = prefs.tool === 'marker' ? MARKER_WIDTHS : PEN_WIDTHS;
  const curColor = prefs.tool === 'marker' ? prefs.markerColor : prefs.penColor;
  const curWidth = prefs.tool === 'marker' ? prefs.markerWidth : prefs.penWidth;

  return (
    <div className="note-editor ink-editor">
      <div className="note-toolbar ink-toolbar" role="toolbar" aria-label="手書きツール" onMouseDown={(e) => (e.target as HTMLElement).closest('button, summary') && e.preventDefault()}>
        <button className="icon-btn" disabled={!undoStack.current.length} onClick={undo} title="元に戻す">↶</button>
        <button className="icon-btn" disabled={!redoStack.current.length} onClick={redo} title="やり直す">↷</button>
        <span className="tb-sep" />
        <button className={`icon-btn${prefs.tool === 'pen' ? ' active' : ''}`} onClick={() => set({ tool: 'pen' })} title="ペン">✒️</button>
        <button className={`icon-btn${prefs.tool === 'marker' ? ' active' : ''}`} onClick={() => set({ tool: 'marker' })} title="マーカー">🖍</button>
        <button className={`icon-btn${prefs.tool === 'eraser' ? ' active' : ''}`} onClick={() => set({ tool: 'eraser' })} title="消しゴム（なぞった線を消す）">⌫</button>
        <span className="tb-sep" />
        {/* 色と太さは 1 つのボタンにまとめて、ツールを替えてもツールバーの幅が変わらないようにする */}
        <details className="menu" style={{ visibility: prefs.tool === 'eraser' ? 'hidden' : undefined }}>
          <summary className="icon-btn ink-current" title="色と太さ">
            <span className="ink-swatch" style={{ background: curColor }} />
            <span className="ink-dot" style={{ width: Math.min(16, Math.max(4, curWidth * (prefs.tool === 'marker' ? 0.6 : 2))), height: Math.min(16, Math.max(4, curWidth * (prefs.tool === 'marker' ? 0.6 : 2))) }} />
          </summary>
          <div className="menu-list ink-menu">
            <div className="menu-caption">{prefs.tool === 'marker' ? 'マーカーの色' : 'ペンの色'}</div>
            <div className="swatches">
              {colors.map((c) => (
                <button
                  key={c}
                  className={`ink-color${c === curColor ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => set(prefs.tool === 'marker' ? { markerColor: c } : { penColor: c })}
                  aria-label={`色 ${c}`}
                />
              ))}
            </div>
            <div className="menu-caption">太さ</div>
            <div className="swatches">
              {widths.map((w) => (
                <button
                  key={w}
                  className={`ink-width${w === curWidth ? ' active' : ''}`}
                  onClick={() => set(prefs.tool === 'marker' ? { markerWidth: w } : { penWidth: w })}
                  aria-label={`太さ ${w}`}
                >
                  <span style={{ width: Math.max(4, w * (prefs.tool === 'marker' ? 0.7 : 2)), height: Math.max(4, w * (prefs.tool === 'marker' ? 0.7 : 2)), background: curColor }} />
                </button>
              ))}
            </div>
          </div>
        </details>
        <span className="tb-sep" />
        <PaperPicker note={note} />
        <button
          className={`icon-btn${settings.fingerDraw ? ' active' : ''}`}
          onClick={() => updateSettings({ fingerDraw: !settings.fingerDraw })}
          title={settings.fingerDraw ? '指でも書く：オン（2本指でスクロール）' : '指でも書く：オフ（指はスクロール）'}
        >
          ☝️
        </button>
      </div>
      <div ref={scrollRef} className="note-scroll ink-scroll" onScroll={updateTiles}>
        <input
          className="note-title ink-title"
          value={title}
          placeholder="ノートのタイトル"
          onChange={(e) => {
            setTitle(e.target.value);
            saveTitle(e.target.value);
          }}
        />
        <div
          ref={paperRef}
          className={`ink-paper paper-${notePaper(note)}${settings.fingerDraw ? ' finger-draw' : ''}${prefs.tool === 'eraser' ? ' erasing' : ''}`}
          style={{ width: W * scale, height: height * scale, '--u': `${scale}px` } as React.CSSProperties}
        >
          <div ref={tilesRef} className="ink-tiles" />
        </div>
      </div>
      <div className="note-status">
        <span>{settings.fingerDraw ? '指でも書けます（2本指でスクロール）' : 'Apple Pencil で書く・指でスクロール'}</span>
        <span className={status === 'error' ? 'status-error' : ''}>
          {{ saved: `保存済み・${formatDate(note.updatedAt)}`, saving: '保存中…', error: '⚠ 保存に失敗しました' }[status]}
        </span>
      </div>
    </div>
  );
}
