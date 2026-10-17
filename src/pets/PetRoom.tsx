import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal, askText } from '../components/Modal';
import { db, today, type Pet, type PetWorld } from '../db';
import { formatDuration } from '../lib/format';
import { currentFullness, foodLeft, HUNGRY_AT, MAX_PETS, nextPetSlotHours, nextUnlock, petSlots, unlockedItems } from './rules';
import { GROUP_LABEL, SPECIES, speciesOf } from './species';
import { ANCHOR, assetUrl, CELL, ROOM, Sprite } from './sprite';
import { adoptPet, ensureWorld, renamePet, setMiniPet } from './world';

/** ペットが最初に立つ場所（部屋の座標、足元） */
const SPOTS = [
  { x: 800, y: 905 },
  { x: 520, y: 960 },
  { x: 1050, y: 975 },
  { x: 330, y: 905 },
  { x: 1300, y: 935 },
];

export default function PetRoom({ onBack }: { onBack: () => void }) {
  const [world, setWorld] = useState<PetWorld | null>(null);
  const liveWorld = useLiveQuery(() => db.petWorld.get('world'), []);
  const pets = useLiveQuery(() => db.pets.orderBy('order').toArray(), []);
  const todaySeconds = useLiveQuery(() => db.sessions.where('date').equals(today()).toArray().then((l) => l.reduce((a, s) => a + s.seconds, 0)), []) ?? 0;
  const [picker, setPicker] = useState(false);
  const [menuPet, setMenuPet] = useState<Pet | null>(null);

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
        <RoomStage items={items} pets={pets} onTapPet={setMenuPet} />

        <aside className="pet-panel">
          <div className="pet-stats">
            <div><span>🍖 餌</span><b>{foodLeft(w)}個</b></div>
            <div><span>今日の学習</span><b>{formatDuration(todaySeconds)}</b></div>
            <div><span>累積学習</span><b>{formatDuration(w.studySeconds)}</b></div>
          </div>
          <ul className="pet-cards">
            {pets.map((p) => {
              const f = currentFullness(p);
              return (
                <li key={p.id}>
                  <button className="pet-card" onClick={() => setMenuPet(p)}>
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
      {menuPet && <PetMenu pet={menuPet} isMini={w.miniPetId === menuPet.id} onClose={() => setMenuPet(null)} />}
    </div>
  );
}

/** 部屋（背景・家具・ペット）。座標は素材と同じ 1536×1024 で、画面に合わせて縮小する */
function RoomStage({ items, pets, onTapPet }: { items: string[]; pets: Pet[]; onTapPet: (p: Pet) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const box = boxRef.current!;
    const fit = () => setScale(Math.min(box.clientWidth / ROOM.width, box.clientHeight / ROOM.height));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  const furniture = Object.entries(ROOM.items).filter(([key]) => items.includes(key));

  return (
    <div ref={boxRef} className="room-box">
      <div className="room" style={{ width: ROOM.width, height: ROOM.height, transform: `scale(${scale})`, visibility: scale ? 'visible' : 'hidden' }}>
        <img className="room-bg" src={assetUrl(`room/${ROOM.background}`)} alt="" draggable={false} />
        {furniture.map(([key, it]) => (
          <img
            key={key}
            className="room-item"
            src={assetUrl(`room/${it.file}`)}
            alt=""
            draggable={false}
            // 奥行き：床に接している位置が手前のものほど上に描く（ラグは常に床の上）
            style={{ left: it.x, top: it.y, width: it.w, height: it.h, zIndex: key === 'rug' ? 1 : it.groundY }}
          />
        ))}
        {pets.map((p, i) => {
          const spot = SPOTS[i % SPOTS.length];
          const size = Math.round(CELL * speciesOf(p.species).scale * 1.1);
          const k = size / CELL;
          return (
            <button
              key={p.id}
              className="room-pet"
              style={{ left: spot.x - ANCHOR[0] * k, top: spot.y - ANCHOR[1] * k, zIndex: spot.y }}
              onClick={() => onTapPet(p)}
              aria-label={p.name}
            >
              <Sprite species={p.species} size={size} />
            </button>
          );
        })}
      </div>
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

function PetMenu({ pet, isMini, onClose }: { pet: Pet; isMini: boolean; onClose: () => void }) {
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
        <button className="btn" onClick={rename}>✎ 名前を変える</button>
        <button className="btn" disabled={isMini} onClick={() => setMiniPet(pet.id).then(onClose)}>
          {isMini ? '📝 ノート画面に表示中' : '📝 ノート画面に出す'}
        </button>
      </div>
    </Modal>
  );
}
