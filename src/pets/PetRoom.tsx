import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { Modal, askText, toast } from '../components/Modal';
import { db, today, type Pet, type PetWorld } from '../db';
import { formatDuration } from '../lib/format';
import { currentFullness, FOOD_PER_10MIN, FOOD_PER_MEAL, foodLeft, HUNGRY_AT, MAX_FULLNESS, MAX_PETS, nextPetSlotHours, nextUnlock, petSlots, unlockedItems } from './rules';
import { GROUP_LABEL, SPECIES, speciesOf } from './species';
import Room, { type RoomHandle } from './Room';
import { Sprite } from './sprite';
import { adoptPet, ensureWorld, feedPets, renamePet, setMiniPet } from './world';

/** ごはんをあげて、食べた子を餌皿へ向かわせる */
async function feed(ids: string[], room: RoomHandle | null) {
  const r = await feedPets(ids);
  if (r.ok) {
    room?.eat(r.fed);
    toast(`ごはんをあげました（餌 −${FOOD_PER_MEAL}）`);
  } else if (r.reason === 'food') {
    toast(`餌が足りません。勉強 10 分で ${FOOD_PER_10MIN} 個もらえます`);
  } else {
    toast(ids.length > 1 ? 'みんなお腹いっぱいです' : 'お腹いっぱいです');
  }
}

export default function PetRoom({ onBack }: { onBack: () => void }) {
  const [world, setWorld] = useState<PetWorld | null>(null);
  const liveWorld = useLiveQuery(() => db.petWorld.get('world'), []);
  const pets = useLiveQuery(() => db.pets.orderBy('order').toArray(), []);
  const todaySeconds = useLiveQuery(() => db.sessions.where('date').equals(today()).toArray().then((l) => l.reduce((a, s) => a + s.seconds, 0)), []) ?? 0;
  const [picker, setPicker] = useState(false);
  const [menuPetId, setMenuPetId] = useState<string | null>(null);
  const roomRef = useRef<RoomHandle>(null);
  const [, setTick] = useState(0);

  // 満腹度は時間で減るので、開いている間も 1 分ごとに表示を更新する
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    ensureWorld().then(setWorld);
  }, []);
  const w = liveWorld ?? world;

  useEffect(() => {
    if (pets && pets.length === 0) setPicker(true);
  }, [pets]);

  if (!w || !pets) return <div className="pet-view loading">読み込み中…</div>;

  const items = unlockedItems(w);
  const next = nextUnlock(w);
  const slots = Math.min(MAX_PETS, petSlots(w));
  const nextSlot = nextPetSlotHours(w);
  const canAdopt = pets.length < slots;
  const food = foodLeft(w);
  const menuPet = pets.find((p) => p.id === menuPetId);
  const feedAll = () => feed(pets.map((p) => p.id), roomRef.current);

  return (
    <div className="pet-view">
      <header className="pet-header">
        <button className="btn ghost" onClick={onBack}>← 戻る</button>
        <h1 className="pet-title">🐾 ペットの部屋</h1>
        <div className="tb-spacer" />
        {canAdopt && (
          <button className="btn primary" onClick={() => setPicker(true)}>＋ 新しい子を迎える</button>
        )}
      </header>

      <div className="pet-body">
        <Room ref={roomRef} items={items} pets={pets} onTapBowl={feedAll} />

        <aside className="pet-panel">
          <div className="pet-stats">
            <div><span>🍖 餌</span><b>{food}個</b></div>
            <div><span>今日の学習</span><b>{formatDuration(todaySeconds)}</b></div>
            <div><span>累積学習</span><b>{formatDuration(w.studySeconds)}</b></div>
            <button className="btn primary feed-all" disabled={food < FOOD_PER_MEAL || !pets.length} onClick={feedAll}>
              🍖 みんなにごはん（餌 {FOOD_PER_MEAL}個）
            </button>
          </div>
          <ul className="pet-cards">
            {pets.map((p) => {
              const f = currentFullness(p);
              return (
                <li key={p.id} className="pet-card-row">
                  <button className="pet-card" onClick={() => setMenuPetId(p.id)}>
                    <Sprite species={p.species} size={44} />
                    <span className="pet-card-main">
                      <span className="pet-card-name">
                        {p.name}
                        {w.miniPetId === p.id && <span className="pet-mini-mark" title="ノート画面に表示中">📝</span>}
                      </span>
                      <span className={`fullness${f <= HUNGRY_AT ? ' low' : ''}`} title={`満腹度 ${f}`}>
                        <span style={{ width: `${f}%` }} />
                      </span>
                    </span>
                    <span className="pet-card-value">{f}</span>
                  </button>
                  <button
                    className="btn icon pet-feed"
                    title={`${p.name}にごはん（餌 ${FOOD_PER_MEAL}個）`}
                    aria-label={`${p.name}にごはん`}
                    disabled={food < FOOD_PER_MEAL || f >= MAX_FULLNESS}
                    onClick={() => feed([p.id], roomRef.current)}
                  >
                    🍖
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="pet-next">
            <div>🪑 次の家具：{next ? `${next.label}（累積 ${next.hours}時間）` : 'すべて解放済み'}</div>
            <div>
              🐾 次のお迎え：
              {pets.length >= MAX_PETS
                ? `最大 ${MAX_PETS}匹まで迎えました`
                : canAdopt
                  ? 'いま迎えられます'
                  : `累積 ${nextSlot}時間`}
            </div>
          </div>
        </aside>
      </div>

      {picker && <PetPicker onClose={() => setPicker(false)} />}
      {menuPet && (
        <PetMenu
          pet={menuPet}
          isMini={w.miniPetId === menuPet.id}
          canFeed={food >= FOOD_PER_MEAL}
          onFeed={() => feed([menuPet.id], roomRef.current).then(() => setMenuPetId(null))}
          onClose={() => setMenuPetId(null)}
        />
      )}
    </div>
  );
}

function PetPicker({ onClose }: { onClose: () => void }) {
  const [species, setSpecies] = useState<string | null>(null);
  const [name, setName] = useState('');
  const groups = (['dog', 'cat', 'marmot', 'bird'] as const).map((g) => ({ g, list: SPECIES.filter((s) => s.group === g) }));

  const adopt = async () => {
    if (!species) return;
    const pet = await adoptPet(species, name.trim() || speciesOf(species).name);
    if (pet) onClose();
  };

  return (
    <Modal
      title="ペットを迎える"
      onClose={onClose}
      width={660}
      footer={
        <>
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" disabled={!species} onClick={adopt}>この子を迎える</button>
        </>
      }
    >
      <div className="species-groups">
        {groups.map(({ g, list }) => (
          <section key={g}>
            <h3>{GROUP_LABEL[g]}</h3>
            <div className="species-grid">
              {list.map((s) => (
                <button key={s.id} className={`species-card${species === s.id ? ' selected' : ''}`} onClick={() => setSpecies(s.id)}>
                  <Sprite species={s.id} size={64} />
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <label className="field">
        <span>名前</span>
        <input value={name} placeholder={species ? speciesOf(species).name : '名前（あとで変えられます）'} onChange={(e) => setName(e.target.value)} maxLength={20} />
      </label>
    </Modal>
  );
}

function PetMenu({ pet, isMini, canFeed, onFeed, onClose }: { pet: Pet; isMini: boolean; canFeed: boolean; onFeed: () => void; onClose: () => void }) {
  const f = currentFullness(pet);
  const rename = async () => {
    const name = await askText({ title: '名前を変える', value: pet.name });
    if (name?.trim()) await renamePet(pet.id, name.trim());
    onClose();
  };
  return (
    <Modal title={pet.name} onClose={onClose} width={360}>
      <div className="pet-menu">
        <Sprite species={pet.species} size={128} />
        <div className="pet-menu-info">
          <div>{speciesOf(pet.species).name}</div>
          <div>満腹度 {f} / 100</div>
          <div className="muted">{new Date(pet.adoptedAt).toLocaleDateString('ja-JP')} にお迎え</div>
        </div>
      </div>
      <div className="pet-menu-actions">
        <button className="btn primary" disabled={!canFeed || f >= MAX_FULLNESS} onClick={onFeed}>
          {f >= MAX_FULLNESS ? 'お腹いっぱい' : `🍖 ごはんをあげる（餌 ${FOOD_PER_MEAL}個）`}
        </button>
        <button className="btn" onClick={rename}>✎ 名前を変える</button>
        <button className="btn" disabled={isMini} onClick={() => setMiniPet(pet.id).then(onClose)}>
          {isMini ? '📝 ノート画面に表示中' : '📝 ノート画面に出す'}
        </button>
      </div>
    </Modal>
  );
}
