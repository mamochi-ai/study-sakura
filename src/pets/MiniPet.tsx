import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { Sprite } from './sprite';

/** ノート画面の上のバーに出す小さなペット（タップで部屋を開く） */
export default function MiniPet({ onOpen }: { onOpen: () => void }) {
  const pet = useLiveQuery(async () => {
    const world = await db.petWorld.get('world');
    return (world?.miniPetId && (await db.pets.get(world.miniPetId))) || (await db.pets.orderBy('order').first()) || null;
  }, []);
  if (pet === undefined) return null;
  return (
    <button className="mini-pet" onClick={onOpen} title={pet ? `${pet.name}の部屋` : 'ペットを迎える'} aria-label="ペットの部屋">
      {pet ? <Sprite species={pet.species} size={40} /> : <span className="mini-pet-empty">🐾</span>}
    </button>
  );
}
