import { db, uid, type Pet, type PetWorld } from '../db';
import { currentFullness, foodLeft, FOOD_PER_MEAL, FULLNESS_DECAY_MS, INITIAL_FULLNESS, MAX_FULLNESS, MAX_PETS, MEAL_FULLNESS, petSlots } from './rules';

/** 部屋の状態を読む。まだ無ければ、これまでの学習記録を合計して作る */
export async function ensureWorld(): Promise<PetWorld> {
  return db.transaction('rw', db.petWorld, db.sessions, async () => {
    const existing = await db.petWorld.get('world');
    if (existing) return existing;
    let total = 0;
    await db.sessions.each((s) => (total += s.seconds));
    const now = Date.now();
    const world: PetWorld = { id: 'world', studySeconds: total, foodSpent: 0, unlocked: [], createdAt: now, updatedAt: now };
    await db.petWorld.add(world);
    return world;
  });
}

export async function adoptPet(species: string, name: string): Promise<Pet | null> {
  const world = await ensureWorld();
  return db.transaction('rw', db.pets, db.petWorld, async () => {
    const count = await db.pets.count();
    if (count >= Math.min(MAX_PETS, petSlots(world))) return null;
    const now = Date.now();
    const pet: Pet = { id: uid(), species, name, fullness: INITIAL_FULLNESS, fullnessAt: now, adoptedAt: now, order: count };
    await db.pets.add(pet);
    if (!world.miniPetId) await db.petWorld.update('world', { miniPetId: pet.id, updatedAt: now });
    return pet;
  });
}

export async function renamePet(id: string, name: string) {
  await db.pets.update(id, { name });
}

export async function setMiniPet(id: string) {
  await db.petWorld.update('world', { miniPetId: id, updatedAt: Date.now() });
}

export type FeedResult = { ok: true; fed: string[] } | { ok: false; reason: 'food' | 'full' };

/**
 * ごはんをあげる。餌 3 個で、指定したペット全員（満腹の子は除く）が食べる。
 * 「みんなにごはん」は全員を、1 匹ずつのときはその子だけを渡す
 */
export async function feedPets(ids: string[]): Promise<FeedResult> {
  await ensureWorld();
  return db.transaction('rw', db.pets, db.petWorld, async () => {
    const world = (await db.petWorld.get('world'))!;
    if (foodLeft(world) < FOOD_PER_MEAL) return { ok: false, reason: 'food' } as const;
    const now = Date.now();
    const pets = (await db.pets.bulkGet(ids)).filter((p): p is Pet => !!p && currentFullness(p, now) < MAX_FULLNESS);
    if (!pets.length) return { ok: false, reason: 'full' } as const;
    for (const p of pets) {
      // 減り方の周期（6 時間ごと）はずらさずに、今の値に足す
      const steps = Math.floor(Math.max(0, now - p.fullnessAt) / FULLNESS_DECAY_MS);
      await db.pets.update(p.id, {
        fullness: Math.min(MAX_FULLNESS, currentFullness(p, now) + MEAL_FULLNESS),
        fullnessAt: p.fullnessAt + steps * FULLNESS_DECAY_MS,
      });
    }
    await db.petWorld.update('world', { foodSpent: world.foodSpent + FOOD_PER_MEAL, updatedAt: now });
    return { ok: true, fed: pets.map((p) => p.id) } as const;
  });
}
