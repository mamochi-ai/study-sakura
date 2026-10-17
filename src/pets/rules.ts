import type { Pet, PetWorld } from '../db';

/** 家具の解放条件（累積学習時間） */
export const FURNITURE_UNLOCKS: { hours: number; items: string[]; label: string }[] = [
  { hours: 0, items: ['bed', 'bowl'], label: '寝床・餌皿' },
  { hours: 1, items: ['rug'], label: 'ラグ' },
  { hours: 3, items: ['ball', 'mouse'], label: 'おもちゃ' },
  { hours: 5, items: ['cushion'], label: 'クッション' },
  { hours: 10, items: ['bookshelf'], label: '本棚' },
  { hours: 20, items: ['plant'], label: '観葉植物' },
  { hours: 40, items: ['cat_tower'], label: 'キャットタワー' },
];

/** 迎えられるペットの数（累積学習時間） */
export const PET_SLOTS = [0, 10, 30, 60, 100];
export const MAX_PETS = PET_SLOTS.length;

export const FOOD_PER_10MIN = 2;
export const FOOD_PER_MEAL = 3;
export const MEAL_FULLNESS = 30;
export const FULLNESS_DECAY = 10;
export const FULLNESS_DECAY_MS = 6 * 60 * 60 * 1000;
export const INITIAL_FULLNESS = 80;
export const HUNGRY_AT = 30;

const hoursOf = (w: Pick<PetWorld, 'studySeconds'>) => w.studySeconds / 3600;

export function unlockedItems(w: PetWorld): string[] {
  const h = hoursOf(w);
  const now = FURNITURE_UNLOCKS.filter((u) => h >= u.hours).flatMap((u) => u.items);
  return [...new Set([...w.unlocked, ...now])];
}

export function nextUnlock(w: PetWorld) {
  const h = hoursOf(w);
  return FURNITURE_UNLOCKS.find((u) => h < u.hours) ?? null;
}

export function petSlots(w: PetWorld) {
  const h = hoursOf(w);
  return PET_SLOTS.filter((x) => h >= x).length;
}

export function nextPetSlotHours(w: PetWorld) {
  const h = hoursOf(w);
  return PET_SLOTS.find((x) => h < x) ?? null;
}

export function foodEarned(w: PetWorld) {
  return Math.floor(w.studySeconds / 600) * FOOD_PER_10MIN;
}

export function foodLeft(w: PetWorld) {
  return Math.max(0, foodEarned(w) - w.foodSpent);
}

/** いまの満腹度（6 時間ごとに 10 ずつ減る。0 より下にはならない） */
export function currentFullness(p: Pick<Pet, 'fullness' | 'fullnessAt'>, now = Date.now()) {
  const steps = Math.floor(Math.max(0, now - p.fullnessAt) / FULLNESS_DECAY_MS);
  return Math.max(0, p.fullness - steps * FULLNESS_DECAY);
}
