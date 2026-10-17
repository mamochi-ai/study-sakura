import type { Pet } from '../db';
import { NavMap, type Pt } from './nav';
import { currentFullness, HUNGRY_AT } from './rules';
import { animOf, frameAt, ROOM } from './sprite';

export type PetState = 'idle' | 'walk' | 'eat' | 'happy' | 'hungry' | 'sleep' | 'play' | 'interact' | 'surprise';
export type Dir = 'front' | 'back' | 'left' | 'right';
/** 歩いた先で何をするか */
type Goal = 'wander' | 'eat' | 'sleep' | 'enterBed' | 'stare' | 'leaveBed';

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
  play: ['idle', 'happy'],
  interact: ['idle', 'happy'],
  surprise: ['idle'],
};

export const canChange = (from: PetState, to: PetState) => from === to || NEXT[from].includes(to);

/** 1 秒あたりに歩く距離（部屋の座標） */
const SPEED = 150;
const sec = (a: number, b: number, rand: () => number) => (a + rand() * (b - a)) * 1000;

function bedSpots() {
  const bed = ROOM.items.bed;
  return {
    inside: { x: bed.x + bed.w * 0.5, y: bed.y + bed.h * 0.7 },
    front: { x: bed.x + bed.w * 0.5, y: bed.groundY + 30 },
  };
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
  inBed = false;
  private path: Pt[] = [];
  private goal: Goal | null = null;
  /** 寝床から出たあとにすること */
  private after: Goal | null = null;
  private lastStare = -Infinity;
  /** 餌皿のまわりのどこで食べるか */
  private slot = 0;

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

  /** 奥行き（大きいほど手前に描く） */
  depth() {
    return this.inBed ? ROOM.items.bed.groundY + 1 : Math.round(this.pos.y);
  }

  private walkTo(goal: Goal, target: Pt, nav: NavMap, now: number) {
    const path = nav.path(this.pos, target);
    if (!path) return this.set('idle', now, 2000);
    this.path = path;
    this.goal = goal;
    if (!this.set('walk', now, Infinity)) this.path = [];
  }

  /** ごはんを食べに行く（餌の消費は world.ts の feedPets） */
  feed(now: number, nav: NavMap, slot = 0) {
    this.slot = slot;
    if (this.state === 'eat' || this.goal === 'eat') return;
    if (this.inBed) {
      this.after = 'eat';
      if (this.state === 'sleep') this.set('idle', now, 0);
      return;
    }
    if (this.state === 'surprise') return;
    this.walkTo('eat', bowlSpot(slot), nav, now);
  }

  /** タップされたらびっくりする */
  poke(now: number) {
    const ms = animOf(this.pet.species, 'surprise');
    const len = (ms.sequence?.length ?? ms.frames) * ms.frameMs;
    if (this.set('surprise', now, len)) {
      this.path = [];
      this.goal = null;
    }
  }

  update(dt: number, now: number, nav: NavMap, items: string[], rand = Math.random) {
    if (this.state === 'walk') return this.step(dt, now, nav);
    if (now < this.until) return;

    switch (this.state) {
      case 'eat':
        this.set('happy', now, 2200);
        return;
      case 'sleep':
      case 'surprise':
      case 'happy':
      case 'hungry':
        this.set('idle', now, sec(1, 3, rand));
        return;
    }
    this.think(now, nav, items, rand);
  }

  /** 待機が終わったら、次にすることを決める */
  private think(now: number, nav: NavMap, items: string[], rand: () => number) {
    if (this.inBed) {
      // 寝床から出る（まっすぐ前へ）
      this.path = [bedSpots().front];
      this.goal = 'leaveBed';
      this.set('walk', now, Infinity);
      return;
    }
    if (this.after) {
      const g = this.after;
      this.after = null;
      if (g === 'eat') return this.walkTo('eat', bowlSpot(this.slot), nav, now);
    }
    const hungry = currentFullness(this.pet) <= HUNGRY_AT;
    if (hungry && items.includes('bowl') && now - this.lastStare > 40_000) {
      this.lastStare = now;
      return this.walkTo('stare', bowlSpot(), nav, now);
    }
    const r = rand();
    if (r < 0.5) return this.walkTo('wander', nav.randomPoint(rand), nav, now);
    if (r < 0.65 && items.includes('bed')) return this.walkTo('sleep', bedSpots().front, nav, now);
    this.set('idle', now, sec(3, 6, rand));
  }

  private step(dt: number, now: number, nav: NavMap) {
    const target = this.path[0];
    if (!target) return this.arrive(now, nav);
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

  private arrive(now: number, nav: NavMap) {
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
      case 'sleep':
        // 寝床の前まで来たら、中に入る（寝床の上は地図の外なので、道順を使わず直接）
        this.inBed = true;
        this.path = [bedSpots().inside];
        this.goal = 'enterBed';
        return;
      case 'enterBed':
        // 入るあいだにごはんを頼まれていたら、眠らずに出る
        if (this.after) break;
        this.set('sleep', now, 25_000 + Math.random() * 20_000);
        return;
      case 'leaveBed':
        this.inBed = false;
        this.pos = nav.nearestFree(this.pos);
        break;
    }
    this.set('idle', now, 1500 + Math.random() * 2500);
  }
}
