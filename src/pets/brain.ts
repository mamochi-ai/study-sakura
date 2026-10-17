import type { Pet } from '../db';
import { NavMap, type Pt } from './nav';
import { currentFullness, HUNGRY_AT } from './rules';
import { animOf, frameAt, ROOM } from './sprite';

export type PetState = 'idle' | 'walk' | 'eat' | 'happy' | 'hungry' | 'sleep' | 'play' | 'interact' | 'surprise';
export type Dir = 'front' | 'back' | 'left' | 'right';
/** 歩いた先で何をするか */
type Goal = 'wander' | 'eat' | 'stare' | 'perch' | 'climb' | 'leave' | 'ball' | 'mouse';

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
      return { key, top: { x: it.x + it.w * 0.24, y: it.y + it.h * 0.43 }, front: { x: it.x + it.w * 0.24, y: it.groundY + 30 }, stay: [{ state: 'idle', min: 8, max: 14 }] };
  }
  return null;
}

/** 餌皿のまわりで食べる場所。何匹かで食べるときは並ぶ */
function bowlSpot(slot = 0) {
  const bowl = ROOM.items.bowl;
  const spots = [
    { x: bowl.x - 50, y: bowl.groundY - 10 },
    { x: bowl.x + bowl.w + 50, y: bowl.groundY - 10 },
    { x: bowl.x + bowl.w * 0.5 - 70, y: bowl.groundY + 60 },
    { x: bowl.x + bowl.w * 0.5 + 90, y: bowl.groundY + 70 },
    { x: bowl.x - 150, y: bowl.groundY + 40 },
  ];
  return spots[slot % spots.length];
}

/** おもちゃの位置（ボールは、遊ぶ絵にボールが描かれているので真上に立つ） */
function toySpot(key: 'ball' | 'mouse') {
  const it = ROOM.items[key];
  return key === 'ball' ? { x: it.x + it.w * 0.5, y: it.groundY - 4 } : { x: it.x + it.w + 40, y: it.groundY - 6 };
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
  anim() {
    if (this.state === 'walk') return `walk_${this.dir}`;
    if (this.state === 'interact') return 'happy';
    return this.state;
  }

  frame(now: number) {
    const def = animOf(this.pet.species, this.anim());
    return frameAt(def, Math.floor((now - this.since) / def.frameMs));
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

  private walkTo(goal: Goal, target: Pt, world: World, now: number) {
    const path = world.nav.path(this.pos, target);
    if (!path) {
      this.release(world);
      return this.set('idle', now, 2000);
    }
    this.path = path;
    this.goal = goal;
    if (!this.set('walk', now, Infinity)) this.path = [];
  }

  /** ごはんを食べに行く（餌の消費は world.ts の feedPets） */
  feed(now: number, world: World, slot = 0) {
    this.slot = slot;
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
      this.path = [];
      this.goal = null;
      if (!this.perch) this.release(world);
    }
  }

  update(dt: number, now: number, world: World, rand = Math.random) {
    if (this.state === 'walk') return this.step(dt, now, world);
    if (now < this.until) return;

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
    if (this.after) {
      this.after = null;
      return this.walkTo('eat', bowlSpot(this.slot), world, now);
    }
    const { items } = world;
    const hungry = currentFullness(this.pet) <= HUNGRY_AT;
    if (hungry && items.includes('bowl') && now - this.lastStare > 40_000) {
      this.lastStare = now;
      return this.walkTo('stare', bowlSpot(), world, now);
    }
    const free = (key: string) => items.includes(key) && !world.taken.has(key);
    const choice = pick<string>(
      [
        [40, 'wander'],
        [25, 'stay'],
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
        return this.walkTo('wander', world.nav.randomPoint(rand), world, now);
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

  private step(dt: number, now: number, world: World) {
    const target = this.path[0];
    if (!target) return this.arrive(now, world);
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const dist = Math.hypot(dx, dy);
    const move = SPEED * dt;
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
    this.set('idle', now, 1500 + Math.random() * 2500);
  }
}
