import type { Pet } from '../db';
import { bodyDist, NavMap, type Pt } from './nav';
import { currentFullness, HUNGRY_AT } from './rules';
import { animOf, frameAt, ROOM } from './sprite';

export type PetState = 'idle' | 'walk' | 'eat' | 'happy' | 'hungry' | 'sleep' | 'play' | 'interact' | 'surprise';
export type Dir = 'front' | 'back' | 'left' | 'right';
/** 歩いた先で何をするか */
type Goal = 'wander' | 'eat' | 'stare' | 'perch' | 'climb' | 'leave' | 'ball' | 'mouse' | 'buddy' | 'duo' | 'chase' | 'follow';

/**
 * 状態マシン：今の状態から移れる状態。ここに無い移り方はしない
 * （食べながら寝る、寝たまま歩く、などの矛盾を防ぐ）
 */
const NEXT: Record<PetState, PetState[]> = {
  idle: ['walk', 'eat', 'sleep', 'hungry', 'happy', 'play', 'interact', 'surprise'],
  walk: ['idle', 'eat', 'sleep', 'hungry', 'play', 'interact', 'surprise'],
  eat: ['happy', 'idle'],
  happy: ['idle', 'walk'],
  hungry: ['idle', 'walk', 'surprise'],
  sleep: ['idle', 'surprise'],
  play: ['idle', 'happy', 'surprise'],
  interact: ['idle', 'happy'],
  surprise: ['idle'],
};

export const canChange = (from: PetState, to: PetState) => from === to || NEXT[from].includes(to);

/** 部屋の中のペット全員で共有するもの */
export interface World {
  nav: NavMap;
  /** 解放済みの家具 */
  items: string[];
  /** 誰かが使っている場所（寝床・クッション・ボールなど）。同時に 2 匹は使わない */
  taken: Map<string, string>;
  /** 部屋にいる全員 */
  actors: PetActor[];
}

/** 1 秒あたりに歩く距離（部屋の座標） */
const SPEED = 150;
const sec = (a: number, b: number, rand: () => number) => (a + rand() * (b - a)) * 1000;

/**
 * 上に乗れる家具。front まで歩いてから、地図の外（家具の上）の top へまっすぐ移る
 * stay：乗っている間の状態と長さ（秒）
 */
interface Perch {
  key: string;
  top: Pt;
  front: Pt;
  stay: { state: 'sleep' | 'idle'; min: number; max: number }[];
}

function perchOf(key: string): Perch | null {
  const it = ROOM.items[key];
  if (!it) return null;
  switch (key) {
    case 'bed':
      return { key, top: { x: it.x + it.w * 0.5, y: it.y + it.h * 0.7 }, front: { x: it.x + it.w * 0.5, y: it.groundY + 30 }, stay: [{ state: 'sleep', min: 25, max: 45 }] };
    case 'cushion':
      return {
        key,
        top: { x: it.x + it.w * 0.5, y: it.y + it.h * 0.58 },
        front: { x: it.x + it.w * 0.5, y: it.groundY + 30 },
        stay: [
          { state: 'idle', min: 8, max: 14 },
          { state: 'sleep', min: 15, max: 25 },
        ],
      };
    case 'cat_tower':
      // 低いほうの台の上
      // 降りる場所は、ボールで遊んでいる子とぶつからないよう右手前
      return { key, top: { x: it.x + it.w * 0.24, y: it.y + it.h * 0.43 }, front: { x: it.x + it.w * 0.41, y: it.groundY + 94 }, stay: [{ state: 'idle', min: 8, max: 14 }] };
  }
  return null;
}

/** 餌皿のまわりで食べる場所。何匹かで食べるときは並ぶ */
function bowlSpot(slot = 0) {
  const bowl = ROOM.items.bowl;
  const cx = bowl.x + bowl.w * 0.5;
  // 餌皿が隠れないよう、横と斜め前に広げて並ぶ
  const spots = [
    // 右どなりはボールとキャットタワーがあるので、右側は斜め前に並ぶ
    { x: bowl.x - 64, y: bowl.groundY - 10 },
    { x: cx + 236, y: bowl.groundY + 94 },
    { x: cx - 314, y: bowl.groundY + 89 },
    { x: cx + 426, y: bowl.groundY + 84 },
    { x: cx - 484, y: bowl.groundY + 4 },
  ];
  return spots[slot % spots.length];
}

/** おもちゃの位置（ボールは、遊ぶ絵にボールが描かれているので真上に立つ） */
function toySpot(key: 'ball' | 'mouse') {
  const it = ROOM.items[key];
  return key === 'ball' ? { x: it.x + it.w * 0.5, y: it.groundY - 4 } : { x: it.x + it.w + 40, y: it.groundY - 6 };
}

/** 仲間との交流の種類 */
type DuoKind = 'greet' | 'sit' | 'sleep' | 'ball' | 'chase';
/** 交流するとき、2 匹が並ぶ間隔（横） */
const DUO_GAP = 180;

/**
 * 2 匹の交流。両方が交流できる状態のときだけ始める。
 * それぞれ決めた場所まで歩き、2 匹ともそろったら同時に始める
 */
export class Duo {
  kind: DuoKind;
  a: PetActor;
  b: PetActor;
  ready = new Set<PetActor>();
  begun = false;
  /** この時刻までにそろわなければやめる */
  deadline: number;
  constructor(kind: DuoKind, a: PetActor, b: PetActor, now: number) {
    this.kind = kind;
    this.a = a;
    this.b = b;
    this.deadline = now + 20_000;
  }
  partnerOf(x: PetActor) {
    return x === this.a ? this.b : this.a;
  }
}

/** 重みつきで 1 つ選ぶ */
function pick<T>(options: [number, T][], rand: () => number): T | null {
  const total = options.reduce((a, [w]) => a + w, 0);
  let r = rand() * total;
  for (const [w, v] of options) if ((r -= w) < 0) return v;
  return null;
}

/** 部屋の中の 1 匹。位置と状態は画面を開いている間だけ持つ（保存はしない） */
export class PetActor {
  pet: Pet;
  pos: Pt;
  dir: Dir = 'front';
  state: PetState = 'idle';
  /** その状態に入った時刻（アニメーションの起点） */
  since = 0;
  /** この時刻になったら次の行動を考える */
  until = 0;
  /** 乗っている家具（寝床・クッション・キャットタワー） */
  perch: Perch | null = null;
  private path: Pt[] = [];
  private goal: Goal | null = null;
  /** 家具から降りたあとにすること */
  private after: 'eat' | null = null;
  private lastStare = -Infinity;
  /** 餌皿のまわりのどこで食べるか */
  private slot = 0;
  /** 使っている場所（World.taken のキー） */
  private claim: string | null = null;
  /** 歩いて向かっている先 */
  dest: Pt | null = null;
  /** ほかの子に道をふさがれて待っている時間（秒） */
  private waited = 0;
  private rerouted = 0;
  /** この時刻までは、ほかの子と重なっても進む */
  private ghostUntil = 0;
  /** 参加している交流 */
  duo: Duo | null = null;
  private lastDuo = -Infinity;
  /** 交流の始めに、相手のほうを向いている時刻まで */
  private faceUntil = 0;
  private followAt = 0;

  constructor(pet: Pet, pos: Pt, now: number) {
    this.pet = pet;
    this.pos = { ...pos };
    this.since = now;
    this.until = now + 1500;
  }

  /** 状態を変える。状態マシンで許されない変化なら何もしない */
  private set(state: PetState, now: number, ms: number) {
    if (!canChange(this.state, state)) return false;
    if (state !== this.state) this.since = now;
    this.state = state;
    this.until = now + ms;
    return true;
  }

  /** 今のアニメーション名 */
  anim(now: number) {
    if (this.state === 'walk') return this.waited > 0 ? 'idle' : `walk_${this.dir}`;
    // 挨拶の始めは、歩く絵の 1 コマ目で相手のほうを向く
    if (this.state === 'interact') return now < this.faceUntil ? `walk_${this.dir}` : 'happy';
    return this.state;
  }

  frame(now: number) {
    if (this.state === 'interact' && now < this.faceUntil) return 0;
    const def = animOf(this.pet.species, this.anim(now));
    return frameAt(def, Math.floor((now - this.since) / def.frameMs));
  }

  /** 交流に誘える状態か（床で待機中か歩き回っている途中・お腹がすいていない・最近交流していない） */
  available(now: number) {
    const free = (this.state === 'idle' && this.until !== Infinity) || (this.state === 'walk' && (this.goal === 'wander' || this.goal === 'buddy'));
    return free && !this.duo && !this.perch && !this.after && !this.claim && now - this.lastDuo > 10_000 && currentFullness(this.pet) > HUNGRY_AT;
  }

  /** 奥行き（大きいほど手前に描く）。家具に乗っている間は、その家具の上 */
  depth() {
    return this.perch ? ROOM.items[this.perch.key].groundY + 1 : Math.round(this.pos.y);
  }

  /** ボールを持って遊んでいる（部屋のボールを隠す） */
  holdsBall() {
    return this.state === 'play' && this.claim === 'ball' && !!animOf(this.pet.species, 'play').hidesBall;
  }

  private take(world: World, key: string) {
    const by = world.taken.get(key);
    if (by && by !== this.pet.id) return false;
    this.release(world);
    world.taken.set(key, this.pet.id);
    this.claim = key;
    return true;
  }

  release(world: World) {
    if (this.claim && world.taken.get(this.claim) === this.pet.id) world.taken.delete(this.claim);
    this.claim = null;
  }

  /** 床で止まっているほかの子（よける相手） */
  private others(world: World) {
    const partner = this.duo?.partnerOf(this);
    return world.actors.filter((o) => o !== this && o !== partner && !o.perch);
  }

  /** 道順を探すときによける点：止まっている子の位置と、歩いている子の行き先 */
  private avoidList(world: World) {
    return this.others(world).flatMap((o) => (o.state === 'walk' ? (o.dest ? [o.dest] : []) : [o.pos]));
  }

  private walkTo(goal: Goal, target: Pt, world: World, now: number) {
    const path = world.nav.path(this.pos, target, this.avoidList(world));
    if (!path) {
      this.release(world);
      return this.set('idle', now, 2000);
    }
    this.path = path;
    this.goal = goal;
    this.dest = path[path.length - 1];
    this.waited = 0;
    if (!this.set('walk', now, Infinity)) this.path = [];
  }

  /** ほかの子と離れた、歩ける場所 */
  private spacious(world: World, rand: () => number, minY = 0) {
    const others = this.others(world);
    let best = world.nav.randomPoint(rand);
    let bestD = -1;
    for (let i = 0; i < 12; i++) {
      const p = world.nav.randomPoint(rand);
      if (p.y < minY) continue;
      const d = Math.min(Infinity, ...others.flatMap((o) => [o.pos, ...(o.dest ? [o.dest] : [])]).map((q) => bodyDist(p, q)));
      if (d > 4) return p;
      if (d > bestD) [best, bestD] = [p, d];
    }
    return best;
  }

  /** 床で休んでいる仲間のとなり */
  private besideBuddy(world: World, rand: () => number): Pt | null {
    const buddies = this.others(world).filter((o) => o.state === 'idle' || o.state === 'sleep');
    if (!buddies.length) return null;
    const b = buddies[Math.floor(rand() * buddies.length)];
    for (const side of rand() < 0.5 ? [-1, 1] : [1, -1]) {
      const p = { x: b.pos.x + side * 150, y: b.pos.y + 6 };
      if (world.nav.walkable(p) && this.others(world).every((o) => bodyDist(p, o.pos) > 1.4)) return p;
    }
    return null;
  }

  /** ごはんを食べに行く（餌の消費は world.ts の feedPets） */
  feed(now: number, world: World, slot = 0) {
    this.slot = slot;
    this.leaveDuo(now, world);
    if (this.state === 'eat' || this.goal === 'eat') return;
    if (this.perch) {
      // 家具の上にいたら、降りてから行く
      this.after = 'eat';
      if (this.state === 'sleep' || this.state === 'idle') this.set('idle', now, 0);
      return;
    }
    if (this.state === 'surprise') return;
    this.release(world);
    this.walkTo('eat', bowlSpot(slot), world, now);
  }

  /** タップされたらびっくりする */
  poke(now: number, world: World) {
    const ms = animOf(this.pet.species, 'surprise');
    const len = (ms.sequence?.length ?? ms.frames) * ms.frameMs;
    if (this.set('surprise', now, len)) {
      this.leaveDuo(now, world);
      this.path = [];
      this.goal = null;
      if (!this.perch) this.release(world);
    }
  }

  update(dt: number, now: number, world: World, rand = Math.random) {
    const duo = this.duo;
    // 相手が来ないまま時間切れ
    if (duo && !duo.begun && now > duo.deadline) this.leaveDuo(now, world);
    if (this.state === 'walk') return this.step(dt, now, world);
    if (now < this.until) return;
    // 交流が終わった
    if (duo?.begun) this.leaveDuo(now, world);

    switch (this.state) {
      case 'eat':
      case 'play':
        if (!this.perch) this.release(world);
        this.set('happy', now, 2200);
        return;
      case 'sleep':
      case 'surprise':
      case 'happy':
      case 'hungry':
      case 'interact':
        this.set('idle', now, sec(1, 3, rand));
        return;
    }
    this.think(now, world, rand);
  }

  /** 待機が終わったら、次にすることを決める */
  private think(now: number, world: World, rand: () => number) {
    if (this.perch) {
      // 家具から降りる（まっすぐ前へ）
      this.path = [this.perch.front];
      this.goal = 'leave';
      this.set('walk', now, Infinity);
      return;
    }
    this.release(world);
    // 食べ終わったあとなどに、ほかの子と重なっていたら少し離れる
    const crowd = this.others(world).find((o) => o.state !== 'walk' && bodyDist(this.pos, o.pos) < 0.8);
    if (crowd) {
      const side = this.pos.x >= crowd.pos.x ? 1 : -1;
      return this.walkTo('wander', { x: this.pos.x + side * 200, y: this.pos.y + (rand() - 0.5) * 80 }, world, now);
    }
    if (this.after) {
      this.after = null;
      return this.walkTo('eat', bowlSpot(this.slot), world, now);
    }
    const { items } = world;
    const hungry = currentFullness(this.pet) <= HUNGRY_AT;
    if (hungry && items.includes('bowl') && now - this.lastStare > 40_000) {
      this.lastStare = now;
      return this.walkTo('stare', bowlSpot(world.actors.indexOf(this)), world, now);
    }
    // おもちゃは、そばにほかの子が止まっていないときだけ
    const roomy = (p: Pt) => this.others(world).every((o) => o.state === 'walk' || bodyDist(p, o.pos) > 1.5);
    const free = (key: string) =>
      items.includes(key) && !world.taken.has(key) && (key !== 'ball' && key !== 'mouse' ? true : roomy(toySpot(key)));
    const choice = pick<string>(
      [
        [40, 'wander'],
        [25, 'stay'],
        [world.actors.length > 1 ? 15 : 0, 'buddy'],
        [world.actors.length > 1 && now - this.lastDuo > 10_000 ? 45 : 0, 'duo'],
        [free('bed') ? 12 : 0, 'bed'],
        [free('cushion') ? 12 : 0, 'cushion'],
        [free('cat_tower') ? 8 : 0, 'cat_tower'],
        [free('ball') ? 12 : 0, 'ball'],
        [free('mouse') ? 6 : 0, 'mouse'],
      ],
      rand,
    );
    switch (choice) {
      case 'wander':
        return this.walkTo('wander', this.spacious(world, rand), world, now);
      case 'buddy': {
        const p = this.besideBuddy(world, rand);
        if (p) return this.walkTo('buddy', p, world, now);
        break;
      }
      case 'duo':
        if (this.startDuo(world, now, rand)) return;
        break;
      case 'bed':
      case 'cushion':
      case 'cat_tower': {
        const perch = perchOf(choice);
        if (perch && this.take(world, choice)) return this.walkTo('perch', perch.front, world, now);
        break;
      }
      case 'ball':
      case 'mouse':
        if (this.take(world, choice)) return this.walkTo(choice, toySpot(choice), world, now);
        break;
    }
    this.set('idle', now, sec(3, 6, rand));
  }

  /** 仲間を誘って交流を始める。誘える相手や場所が無ければ false */
  private startDuo(world: World, now: number, rand: () => number) {
    const partners = world.actors.filter((o) => o !== this && o.available(now));
    if (!partners.length) return false;
    const other = partners[Math.floor(rand() * partners.length)];
    const kind = pick<DuoKind>(
      [
        [3, 'greet'],
        [2, 'sit'],
        [2, 'sleep'],
        [2, 'chase'],
        [world.items.includes('ball') && !world.taken.has('ball') ? 2 : 0, 'ball'],
      ],
      rand,
    )!;
    const duo = new Duo(kind, this, other, now);
    // ほかの子（この 2 匹以外）と重ならない場所か
    const okSpot = (p: Pt) => world.nav.walkable(p) && world.actors.every((o) => o === this || o === other || o.perch || bodyDist(p, o.dest ?? o.pos) > 1.4);
    const pair = (base: Pt): [Pt, Pt] | null => {
      for (const d of [DUO_GAP, -DUO_GAP]) {
        const q = { x: base.x + d, y: base.y };
        if (okSpot(base) && okSpot(q)) return d > 0 ? [base, q] : [q, base];
      }
      return null;
    };
    let spots: [Pt, Pt] | null = null;
    switch (kind) {
      case 'greet': {
        // 2 匹の真ん中で向き合う
        const mid = { x: (this.pos.x + other.pos.x) / 2, y: (this.pos.y + other.pos.y) / 2 };
        spots = pair({ x: mid.x - DUO_GAP / 2, y: mid.y }) ?? pair(this.pos);
        if (spots && this.pos.x > other.pos.x) spots = [spots[1], spots[0]];
        break;
      }
      case 'sit':
      case 'sleep':
        // 家具に隠れないよう、部屋の手前側で
        for (let i = 0; i < 6 && !spots; i++) spots = pair(this.spacious(world, rand, 800));
        break;
      case 'ball': {
        // 誘った子がボールで遊び、相手はとなりで喜ぶ
        const ball = toySpot('ball');
        for (const d of [DUO_GAP, -DUO_GAP]) {
          const q = { x: ball.x + d, y: ball.y + 10 };
          if (!spots && okSpot(q)) spots = [ball, q];
        }
        if (spots && !this.take(world, 'ball')) spots = null;
        break;
      }
      case 'chase': {
        // 誘った子が部屋を何か所か走り、相手が追いかける
        const route = [this.spacious(world, rand), this.spacious(world, rand), this.spacious(world, rand)];
        const path: Pt[] = [];
        let from = this.pos;
        for (const p of route) {
          const leg = world.nav.path(from, p);
          if (!leg) break;
          path.push(...leg);
          from = p;
        }
        if (!path.length) return false;
        this.duo = other.duo = duo;
        this.path = path;
        this.goal = 'chase';
        this.dest = path[path.length - 1];
        this.set('walk', now, Infinity);
        other.path = [];
        other.goal = 'follow';
        other.set('walk', now, Infinity);
        return true;
      }
    }
    if (!spots) {
      if (kind === 'ball') this.release(world);
      return false;
    }
    this.duo = other.duo = duo;
    const [mine, theirs] = spots;
    this.walkTo('duo', mine, world, now);
    other.walkTo('duo', theirs, world, now);
    if (this.goal !== 'duo' || other.goal !== 'duo') {
      this.leaveDuo(now, world);
      return false;
    }
    return true;
  }

  /** 2 匹がそろったので、同時に始める */
  private beginDuo(duo: Duo, now: number) {
    duo.begun = true;
    const { a, b } = duo;
    const len = { greet: sec(3, 4, Math.random), sit: sec(10, 14, Math.random), sleep: sec(18, 26, Math.random), ball: sec(6, 9, Math.random), chase: 2500 }[duo.kind];
    for (const x of [a, b]) {
      const o = duo.partnerOf(x);
      // 相手のほうを向く
      x.dir = o.pos.x < x.pos.x ? 'left' : 'right';
      switch (duo.kind) {
        case 'greet':
        case 'chase':
          x.faceUntil = now + 1000;
          x.set('interact', now, len);
          break;
        case 'sit':
          x.set('idle', now, len);
          break;
        case 'sleep':
          x.set('sleep', now, len);
          break;
        case 'ball':
          x.set(x === a ? 'play' : 'interact', now, len);
          break;
      }
    }
  }

  /** 交流から抜ける。始まる前なら相手も待つのをやめる */
  private leaveDuo(now: number, world: World) {
    const duo = this.duo;
    if (!duo) return;
    for (const x of [duo.a, duo.b]) {
      if (x.duo !== duo) continue;
      x.duo = null;
      x.lastDuo = now;
      if (!duo.begun && x !== this) {
        // 相手は歩くのをやめて待機に戻る
        if (x.state === 'walk' && (x.goal === 'duo' || x.goal === 'chase' || x.goal === 'follow')) {
          x.path = [];
          x.goal = null;
          x.dest = null;
          x.set('idle', now, 1500);
        } else if (x.state === 'idle' && x.until === Infinity) x.set('idle', now, 1500);
        if (x.claim === 'ball' && x.state !== 'play') x.release(world);
      }
    }
    if (this.state === 'walk' && (this.goal === 'follow' || this.goal === 'duo' || this.goal === 'chase')) {
      this.path = [];
      this.goal = null;
      this.dest = null;
    }
    // 相手を待っていたなら、待つのをやめる
    if (this.state === 'idle' && this.until === Infinity) this.set('idle', now, 1500);
    if (this.claim === 'ball' && this.state !== 'play') this.release(world);
  }

  /** 追いかけっこで、先を走る子を追う */
  private follow(dt: number, now: number, world: World) {
    const leader = this.duo?.partnerOf(this);
    if (!leader || !this.duo) {
      this.goal = null;
      this.set('idle', now, 1000);
      return;
    }
    // 先の子が止まったら、となりに並んで終わる
    if (leader.goal !== 'chase') {
      const side = this.pos.x < leader.pos.x ? -1 : 1;
      this.path = world.nav.path(this.pos, { x: leader.pos.x + side * DUO_GAP, y: leader.pos.y }) ?? [];
      this.goal = 'chase';
      return;
    }
    const dx = leader.pos.x - this.pos.x;
    const dy = leader.pos.y - this.pos.y;
    const dist = Math.hypot(dx, dy);
    // 近づきすぎない
    if (dist < 160) {
      this.waited = 0.01;
      return;
    }
    this.waited = 0;
    if (now - this.followAt > 500 || !this.path.length) {
      this.followAt = now;
      this.path = world.nav.clear(this.pos, leader.pos) ? [{ ...leader.pos }] : world.nav.path(this.pos, leader.pos) ?? [];
    }
    const target = this.path[0];
    if (!target) return;
    const tx = target.x - this.pos.x;
    const ty = target.y - this.pos.y;
    const td = Math.hypot(tx, ty);
    const move = SPEED * 1.45 * dt;
    if (td > 1) this.dir = Math.abs(tx) > Math.abs(ty) * 0.8 ? (tx < 0 ? 'left' : 'right') : ty < 0 ? 'back' : 'front';
    if (td <= move) {
      this.pos = { ...target };
      this.path.shift();
    } else this.pos = { x: this.pos.x + (tx / td) * move, y: this.pos.y + (ty / td) * move };
  }

  private step(dt: number, now: number, world: World) {
    if (this.goal === 'follow') return this.follow(dt, now, world);
    const target = this.path[0];
    if (!target) return this.arrive(now, world);
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const dist = Math.hypot(dx, dy);
    const move = (this.goal === 'chase' ? SPEED * 1.5 : SPEED) * dt;
    // 家具の上り下りの間は、ほかの子を気にしない
    if (!this.perch && dist > 1) {
      const ahead = { x: this.pos.x + (dx / dist) * 45, y: this.pos.y + (dy / dist) * 45 };
      const blocker = this.others(world).find((o) => bodyDist(ahead, o.pos) < 1 && bodyDist(ahead, o.pos) < bodyDist(this.pos, o.pos));
      if (blocker && now > this.ghostUntil) {
        this.waited += dt;
        // 相手も歩いているなら、少し待てばどいてくれる
        if (blocker.state === 'walk' && this.waited < 1.2) return;
        // 止まっている相手や、長く待ったときは回り道を探す（探すのは 0.8 秒に 1 回まで）
        const end = this.path[this.path.length - 1];
        if (this.goal && end && now - this.rerouted > 800) {
          this.rerouted = now;
          const path = world.nav.path(this.pos, end, [blocker.pos, ...this.avoidList(world)]);
          if (path) {
            this.path = path;
            this.waited = 0;
            return;
          }
        }
        // どうしても動けないときは、すれ違う（重なって通り抜ける）
        if (this.waited > 4) this.ghostUntil = now + 1500;
        return;
      }
      this.waited = 0;
    }
    if (dist > 1) {
      // 奥行き方向は画面上で短く見えるので、横向きを優先する
      this.dir = Math.abs(dx) > Math.abs(dy) * 0.8 ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'back' : 'front';
    }
    if (dist <= move) {
      this.pos = { ...target };
      this.path.shift();
    } else {
      this.pos = { x: this.pos.x + (dx / dist) * move, y: this.pos.y + (dy / dist) * move };
    }
  }

  private arrive(now: number, world: World) {
    const goal = this.goal;
    this.goal = null;
    this.dest = null;
    this.dir = 'front';
    switch (goal) {
      case 'eat':
        this.set('eat', now, 7000);
        return;
      case 'stare':
        this.set('hungry', now, 6000);
        return;
      case 'ball':
        this.set('play', now, sec(6, 10, Math.random));
        return;
      case 'mouse':
        this.set('happy', now, sec(3, 5, Math.random));
        return;
      case 'duo':
      case 'chase':
        if (this.duo) {
          this.duo.ready.add(this);
          this.set('idle', now, Infinity);
          if (this.duo.ready.size === 2) this.beginDuo(this.duo, now);
          return;
        }
        break;
      case 'buddy':
        // 仲間のとなりで休む
        if (Math.random() < 0.4) this.set('sleep', now, sec(15, 25, Math.random));
        else this.set('idle', now, sec(8, 14, Math.random));
        return;
      case 'perch': {
        // 家具の前まで来たら、上に乗る（家具の上は地図の外なので、道順を使わず直接）
        const perch = this.claim ? perchOf(this.claim) : null;
        if (!perch) break;
        this.perch = perch;
        this.path = [perch.top];
        this.goal = 'climb';
        return;
      }
      case 'climb': {
        // 乗るあいだにごはんを頼まれていたら、すぐ降りる
        if (this.after || !this.perch) break;
        const stay = pick(this.perch.stay.map((s) => [1, s] as [number, Perch['stay'][number]]), Math.random)!;
        this.set(stay.state, now, sec(stay.min, stay.max, Math.random));
        return;
      }
      case 'leave':
        this.perch = null;
        this.release(world);
        this.pos = world.nav.nearestFree(this.pos);
        break;
    }
    // ほかの子と重なる場所で止まったら、すぐに離れる（次の think で動く）
    const crowded = this.others(world).some((o) => o.state !== 'walk' && bodyDist(this.pos, o.pos) < 0.8);
    this.set('idle', now, crowded ? 0 : 1500 + Math.random() * 2500);
  }
}
