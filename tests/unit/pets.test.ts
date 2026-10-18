import { describe, expect, it } from 'vitest';
import type { PetWorld } from '../../src/db';
import { canChange } from '../../src/pets/brain';
import { bodyDist, NavMap } from '../../src/pets/nav';
import { currentFullness, foodLeft, nextUnlock, petSlots, unlockedItems } from '../../src/pets/rules';
import { ROOM } from '../../src/pets/sprite';

const world = (hours: number, patch: Partial<PetWorld> = {}): PetWorld => ({ id: 'world', studySeconds: hours * 3600, foodSpent: 0, unlocked: [], createdAt: 0, updatedAt: 0, ...patch });

describe('餌・満腹度', () => {
  it('学習 10 分につき 2 個（秒単位で積み上がる）。使った分は減る', () => {
    expect(foodLeft(world(0, { studySeconds: 599 }))).toBe(0);
    expect(foodLeft(world(0, { studySeconds: 540 + 60 }))).toBe(2);
    expect(foodLeft(world(1, { foodSpent: 3 }))).toBe(9);
    expect(foodLeft(world(0, { foodSpent: 5 }))).toBe(0);
  });

  it('満腹度は 6 時間ごとに 10 減り、0 で止まる', () => {
    const h = 3600_000;
    expect(currentFullness({ fullness: 80, fullnessAt: 0 }, 5.9 * h)).toBe(80);
    expect(currentFullness({ fullness: 80, fullnessAt: 0 }, 6 * h)).toBe(70);
    expect(currentFullness({ fullness: 20, fullnessAt: 0 }, 100 * h)).toBe(0);
  });
});

describe('家具・お迎え', () => {
  it('累積学習時間で家具が増え、一度解放したら消えない', () => {
    expect(unlockedItems(world(0))).toEqual(['bed', 'bowl']);
    expect(unlockedItems(world(3))).toEqual(['bed', 'bowl', 'rug', 'ball', 'mouse']);
    expect(unlockedItems(world(40))).toContain('cat_tower');
    expect(unlockedItems(world(0, { unlocked: ['cushion'] }))).toContain('cushion');
    expect(nextUnlock(world(4.9))?.label).toBe('クッション');
    expect(nextUnlock(world(50))).toBeNull();
  });

  it('お迎えできる数：0・10・30・60・100 時間', () => {
    expect([0, 9.9, 10, 30, 60, 100, 500].map((h) => petSlots(world(h)))).toEqual([1, 1, 2, 3, 4, 5, 5]);
  });
});

describe('状態マシン', () => {
  it('矛盾した動きには移らない', () => {
    expect(canChange('eat', 'sleep')).toBe(false);
    expect(canChange('sleep', 'walk')).toBe(false);
    expect(canChange('sleep', 'idle')).toBe(true);
    expect(canChange('idle', 'walk')).toBe(true);
    expect(canChange('surprise', 'eat')).toBe(false);
  });
});

describe('歩ける場所', () => {
  const all = Object.keys(ROOM.items);
  const nav = new NavMap(all);
  const inside = (p: { x: number; y: number }, key: string) => {
    const it = ROOM.items[key];
    return p.x > it.x + it.w * 0.2 && p.x < it.x + it.w * 0.8 && p.y > it.groundY - 40 && p.y < it.groundY;
  };

  it('家具の足元には立てない', () => {
    const bed = ROOM.items.bed;
    expect(nav.walkable({ x: bed.x + bed.w / 2, y: bed.groundY - 20 })).toBe(false);
    expect(nav.walkable({ x: 760, y: 980 })).toBe(true);
  });

  it('道順は家具をよけ、ほかのペットもよける', () => {
    const path = nav.path({ x: 80, y: 990 }, { x: 1450, y: 990 })!;
    expect(path).not.toBeNull();
    let prev = { x: 80, y: 990 };
    for (const p of path) {
      for (let t = 0; t <= 1; t += 0.05) {
        const q = { x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t };
        for (const key of ['bed', 'bowl', 'cushion', 'cat_tower']) expect(inside(q, key)).toBe(false);
      }
      prev = p;
    }
    const blocker = { x: 760, y: 960 };
    const around = nav.path({ x: 500, y: 960 }, { x: 1000, y: 960 }, [blocker])!;
    expect(around.every((p) => bodyDist(p, blocker) >= 1)).toBe(true);
  });
});
