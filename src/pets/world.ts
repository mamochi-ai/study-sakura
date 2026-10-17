import { db, uid, type Pet, type PetWorld } from '../db';
import { INITIAL_FULLNESS, MAX_PETS, petSlots } from './rules';

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
