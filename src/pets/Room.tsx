import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Pet } from '../db';
import { PetActor } from './brain';
import { NavMap, type Pt } from './nav';
import { speciesOf } from './species';
import { ANCHOR, animOf, assetUrl, CELL, ROOM } from './sprite';

/** ペットが最初に立つ場所（部屋の座標、足元） */
const SPOTS: Pt[] = [
  { x: 760, y: 960 },
  { x: 560, y: 940 },
  { x: 1180, y: 960 },
  { x: 380, y: 960 },
  { x: 1350, y: 975 },
];

const sizeOf = (species: string) => Math.round(CELL * speciesOf(species).scale * 1.1);

/** 使うかもしれないアニメーションの画像を先に読み込んでおく（切り替えたときにちらつかないように） */
const preloaded = new Set<string>();
function preload(species: string) {
  for (const name of ['idle', 'walk_front', 'walk_back', 'walk_left', 'walk_right', 'eat', 'hungry', 'sleep', 'happy', 'surprise']) {
    const url = assetUrl(`pets/${animOf(species, name).file}`);
    if (preloaded.has(url)) continue;
    preloaded.add(url);
    const img = new Image();
    img.src = url;
  }
}

export interface RoomHandle {
  /** ごはんをもらったペットを餌皿へ向かわせる */
  eat: (ids: string[]) => void;
}

/** 部屋（背景・家具・ペット）。座標は素材と同じ 1536×1024 で、画面に合わせて縮小する */
const Room = forwardRef<RoomHandle, { items: string[]; pets: Pet[]; onTapBowl: () => void }>(function Room({ items, pets, onTapBowl }, ref) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const actors = useRef(new Map<string, PetActor>());
  const els = useRef(new Map<string, HTMLDivElement>());
  const nav = useMemo(() => new NavMap(items), [items.join()]);
  const navRef = useRef(nav);
  navRef.current = nav;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useLayoutEffect(() => {
    const box = boxRef.current!;
    const fit = () => setScale(Math.min(box.clientWidth / ROOM.width, box.clientHeight / ROOM.height));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // 飼っているペットとアクターを対応させる（満腹度などの最新値も渡す）
  useEffect(() => {
    const now = performance.now();
    const map = actors.current;
    pets.forEach((p, i) => {
      const a = map.get(p.id);
      if (a) a.pet = p;
      else {
        preload(p.species);
        map.set(p.id, new PetActor(p, navRef.current.nearestFree(SPOTS[i % SPOTS.length]), now));
      }
    });
    for (const id of map.keys()) if (!pets.some((p) => p.id === id)) map.delete(id);
  }, [pets]);

  // 動かす。画面が隠れている間は止める
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const shown = new Map<string, string>();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      for (const [id, a] of actors.current) {
        a.update(dt, now, navRef.current, itemsRef.current);
        const el = els.current.get(id);
        if (!el) continue;
        const size = sizeOf(a.pet.species);
        const k = size / CELL;
        const def = animOf(a.pet.species, a.anim());
        if (shown.get(id) !== def.file) {
          shown.set(id, def.file);
          const sprite = el.firstElementChild as HTMLElement;
          sprite.style.backgroundImage = `url(${assetUrl(`pets/${def.file}`)})`;
          sprite.style.backgroundSize = `${def.frames * size}px ${size}px`;
        }
        (el.firstElementChild as HTMLElement).style.backgroundPosition = `${-a.frame(now) * size}px 0`;
        el.style.transform = `translate(${a.pos.x - ANCHOR[0] * k}px, ${a.pos.y - ANCHOR[1] * k}px)`;
        el.style.zIndex = String(a.depth());
        el.dataset.state = a.state;
      }
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const onVisibility = () => (document.hidden ? cancelAnimationFrame(raf) : start());
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    eat: (ids) => {
      const now = performance.now();
      ids.forEach((id, i) => actors.current.get(id)?.feed(now, navRef.current, i));
    },
  }));

  const furniture = Object.entries(ROOM.items).filter(([key]) => items.includes(key));

  return (
    <div ref={boxRef} className="room-box">
      <div className="room" style={{ width: ROOM.width, height: ROOM.height, transform: `scale(${scale})`, visibility: scale ? 'visible' : 'hidden' }}>
        <img className="room-bg" src={assetUrl(`room/${ROOM.background}`)} alt="" draggable={false} />
        {furniture.map(([key, it]) => (
          <img
            key={key}
            className={`room-item${key === 'bowl' ? ' tappable' : ''}`}
            src={assetUrl(`room/${it.file}`)}
            alt=""
            draggable={false}
            onClick={key === 'bowl' ? onTapBowl : undefined}
            // 奥行き：床に接している位置が手前のものほど上に描く（ラグは常に床の上）
            style={{ left: it.x, top: it.y, width: it.w, height: it.h, zIndex: key === 'rug' ? 1 : it.groundY }}
          />
        ))}
        {pets.map((p) => {
          const size = sizeOf(p.species);
          return (
            <div
              key={p.id}
              ref={(el) => {
                if (el) els.current.set(p.id, el);
                else els.current.delete(p.id);
              }}
              className="room-pet"
              role="button"
              aria-label={p.name}
              onClick={() => actors.current.get(p.id)?.poke(performance.now())}
            >
              <div className="sprite" style={{ width: size, height: size }} />
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default Room;
