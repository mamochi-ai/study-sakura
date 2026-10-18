import { ROOM, type RoomItem } from './sprite';

/** 床の上の点（部屋の座標。ペットの足元） */
export interface Pt {
  x: number;
  y: number;
}

/** 足元が置ける床の範囲（奥の壁と左の壁を避ける） */
const FLOOR = { top: 610, bottom: 1000, left: 40, right: 1496 };
/** 左の壁は斜めなので、奥ほど左端を右に寄せる */
const leftEdge = (y: number) => FLOOR.left + Math.max(0, (760 - y) * 1.2);

/** ペットが通れない家具（床に接している部分だけ）。ラグ・おもちゃは上を歩ける */
const SOLID = ['bed', 'bowl', 'cushion', 'bookshelf', 'plant', 'cat_tower'];
/** ペットの体の幅のぶん、家具の周りを空けておく */
const PAD_X = 45;
const PAD_Y = 18;

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 家具が床をふさいでいる範囲 */
export function footprint(it: RoomItem): Box {
  const depth = Math.min(it.h * 0.55, 150);
  return { x1: it.x + it.w * 0.06, x2: it.x + it.w * 0.94, y1: it.groundY - depth, y2: it.groundY };
}

/** ほかのペットの体の大きさ（この楕円の中には入らない） */
export const BODY_RX = 125;
export const BODY_RY = 42;
/** 楕円の中か（1 未満なら重なる） */
export const bodyDist = (a: Pt, b: Pt) => ((a.x - b.x) / BODY_RX) ** 2 + ((a.y - b.y) / BODY_RY) ** 2;

const GRID = 24;
const COLS = Math.ceil(ROOM.width / GRID);
const ROWS = Math.ceil(ROOM.height / GRID);

/** 解放済みの家具に合わせた、歩ける場所の地図 */
export class NavMap {
  private blocked: Box[];
  private free: Uint8Array;
  /** 道順を探す間だけ、よけるほかのペットの位置 */
  private avoid: Pt[] = [];
  /** 自分の出発点のまわりは、ほかの子と重なっていても通れるようにする */
  private origin: Pt | null = null;

  constructor(items: string[]) {
    this.blocked = SOLID.filter((k) => items.includes(k) && ROOM.items[k]).map((k) => {
      const b = footprint(ROOM.items[k]);
      return { x1: b.x1 - PAD_X, x2: b.x2 + PAD_X, y1: b.y1 - PAD_Y, y2: b.y2 + PAD_Y };
    });
    this.free = new Uint8Array(COLS * ROWS);
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) this.free[r * COLS + c] = this.walkable({ x: c * GRID + GRID / 2, y: r * GRID + GRID / 2 }) ? 1 : 0;
  }

  /** その点に足元を置けるか（床の中で、家具に重ならない） */
  walkable(p: Pt) {
    if (p.y < FLOOR.top || p.y > FLOOR.bottom || p.x < leftEdge(p.y) || p.x > FLOOR.right) return false;
    if (this.blocked.some((b) => p.x > b.x1 && p.x < b.x2 && p.y > b.y1 && p.y < b.y2)) return false;
    return !this.crowded(p);
  }

  /** ほかのペットに重なるか（道順を探している間だけ） */
  private crowded(p: Pt) {
    if (!this.avoid.length) return false;
    if (this.origin && bodyDist(p, this.origin) < 1) return false;
    return this.avoid.some((o) => bodyDist(p, o) < 1);
  }

  /** a から b までまっすぐ歩けるか */
  clear(a: Pt, b: Pt) {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (!this.walkable({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
    }
    return true;
  }

  /** 近くの歩ける点（家具にめり込んだ点をはじき出す） */
  nearestFree(p: Pt): Pt {
    if (this.walkable(p)) return p;
    for (let r = 1; r < 40; r++) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const q = { x: p.x + Math.cos(a) * r * 12, y: p.y + Math.sin(a) * r * 6 };
        if (this.walkable(q)) return q;
      }
    }
    return { x: 760, y: 980 };
  }

  /** ランダムな歩ける点 */
  randomPoint(rand = Math.random): Pt {
    for (let i = 0; i < 200; i++) {
      const p = { x: FLOOR.left + rand() * (FLOOR.right - FLOOR.left), y: FLOOR.top + rand() * (FLOOR.bottom - FLOOR.top) };
      if (this.walkable(p)) return p;
    }
    return { x: 760, y: 980 };
  }

  /** a から b までの道順（家具と、avoid に渡したほかのペットをよける）。たどり着けなければ null */
  path(a: Pt, b: Pt, avoid: Pt[] = []): Pt[] | null {
    const start = this.nearestFree(a);
    this.avoid = avoid;
    this.origin = start;
    try {
      return this.search(start, this.nearestFree(b));
    } finally {
      this.avoid = [];
      this.origin = null;
    }
  }

  private search(start: Pt, goal: Pt): Pt[] | null {
    if (this.clear(start, goal)) return [goal];
    const cell = (p: Pt) => Math.min(ROWS - 1, Math.max(0, Math.floor(p.y / GRID))) * COLS + Math.min(COLS - 1, Math.max(0, Math.floor(p.x / GRID)));
    const s = cell(start);
    const g = cell(goal);
    const center = (i: number): Pt => ({ x: (i % COLS) * GRID + GRID / 2, y: Math.floor(i / COLS) * GRID + GRID / 2 });
    // A*（8 方向）
    const gScore = new Float32Array(COLS * ROWS).fill(Infinity);
    const from = new Int32Array(COLS * ROWS).fill(-1);
    const open: number[] = [s];
    const fScore = new Map<number, number>();
    gScore[s] = 0;
    const h = (i: number) => Math.hypot((i % COLS) - (g % COLS), Math.floor(i / COLS) - Math.floor(g / COLS));
    fScore.set(s, h(s));
    let found = false;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (fScore.get(open[i])! < fScore.get(open[bi])!) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur === g) {
        found = true;
        break;
      }
      const cx = cur % COLS;
      const cy = Math.floor(cur / COLS);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
          const n = ny * COLS + nx;
          if ((!this.free[n] || this.crowded(center(n))) && n !== g) continue;
          const t = gScore[cur] + (dx && dy ? Math.SQRT2 : 1);
          if (t < gScore[n]) {
            gScore[n] = t;
            from[n] = cur;
            fScore.set(n, t + h(n));
            if (!open.includes(n)) open.push(n);
          }
        }
    }
    if (!found) return null;
    const cells: Pt[] = [];
    for (let i = g; i !== -1 && i !== s; i = from[i]) cells.unshift(center(i));
    cells[cells.length - 1] = goal;
    // 見通しのきく点は飛ばして、なめらかな道にする
    const out: Pt[] = [];
    let at = start;
    let i = 0;
    while (i < cells.length) {
      let j = cells.length - 1;
      while (j > i && !this.clear(at, cells[j])) j--;
      out.push(cells[j]);
      at = cells[j];
      i = j + 1;
    }
    return out;
  }
}
