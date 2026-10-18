import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Pet } from '../db';
import { PetActor, type World } from './brain';
import { NavMap, type Pt } from './nav';
import { speciesOf } from './species';
import { ANCHOR, animOf, assetUrl, CELL, preloadSpecies, ROOM } from './sprite';

/** ペットが最初に立つ場所（部屋の座標、足元） */
const SPOTS: Pt[] = [
  { x: 760, y: 960 },
  { x: 560, y: 940 },
  { x: 1180, y: 960 },
  { x: 380, y: 960 },
  { x: 1350, y: 975 },
];

const sizeOf = (species: string) => Math.round(CELL * speciesOf(species).scale * 1.1);

export interface RoomHandle {
  /** ごはんをもらったペットを餌皿へ向かわせる */
  eat: (ids: string[]) => void;
}

/** 部屋（背景・家具・ペット）。座標は素材と同じ 1536×1024 で、画面に合わせて縮小する */
const Room = forwardRef<RoomHandle, { items: string[]; pets: Pet[]; fresh?: string[]; onTapBowl: () => void }>(function Room({ items, pets, fresh = [], onTapBowl }, ref) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const actors = useRef(new Map<string, PetActor>());
  const els = useRef(new Map<string, HTMLDivElement>());
  const nav = useMemo(() => new NavMap(items), [items.join()]);
  const world = useRef<World>({ nav, items, taken: new Map(), actors: [] }).current;
  world.nav = nav;
  world.items = items;
  const ballRef = useRef<HTMLImageElement>(null);
  // 自動テスト用：?petdebug を付けて開くと、部屋の状態を外から見られる
  if (location.search.includes('petdebug')) (window as unknown as { __petWorld: World }).__petWorld = world;

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
        preloadSpecies(p.species);
        map.set(p.id, new PetActor(p, world.nav.nearestFree(SPOTS[i % SPOTS.length]), now));
      }
    });
    for (const [id, a] of map) {
      if (pets.some((p) => p.id === id)) continue;
      a.release(world);
      map.delete(id);
    }
    world.actors = [...map.values()];
  }, [pets, world]);

  // 動かす。画面が隠れている間は止める
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    // 前のフレームで書いた値。変わったときだけ DOM に書く（5 匹でも軽く保つ）
    const shown = new Map<string, { file: string; frame: number; transform: string; z: number; state: string; duo: string }>();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      let ballHeld = false;
      for (const [id, a] of actors.current) {
        a.update(dt, now, world);
        ballHeld ||= a.holdsBall();
        const el = els.current.get(id);
        if (!el) continue;
        const sprite = el.firstElementChild as HTMLElement;
        const size = sizeOf(a.pet.species);
        const k = size / CELL;
        const def = animOf(a.pet.species, a.anim(now));
        let prev = shown.get(id);
        if (!prev) shown.set(id, (prev = { file: '\0', frame: -1, transform: '', z: -1, state: '', duo: '' }));
        if (prev.file !== def.file) {
          prev.file = def.file;
          prev.frame = -1;
          // 画像が無いときは仮の表示
          sprite.classList.toggle('sprite-placeholder', !def.file);
          sprite.textContent = def.file ? '' : '🐾';
          sprite.style.fontSize = `${size * 0.4}px`;
          sprite.style.backgroundImage = def.file ? `url(${assetUrl(`pets/${def.file}`)})` : 'none';
          sprite.style.backgroundSize = `${def.frames * size}px ${size}px`;
        }
        const frame = a.frame(now);
        if (prev.frame !== frame) sprite.style.backgroundPosition = `${-(prev.frame = frame) * size}px 0`;
        const transform = `translate(${(a.pos.x - ANCHOR[0] * k).toFixed(1)}px, ${(a.pos.y - ANCHOR[1] * k).toFixed(1)}px)`;
        if (prev.transform !== transform) el.style.transform = prev.transform = transform;
        const z = a.depth();
        if (prev.z !== z) el.style.zIndex = String((prev.z = z));
        if (prev.state !== a.state) el.dataset.state = prev.state = a.state;
        const duo = a.duo ? `${a.duo.kind}${a.duo.begun ? '' : '…'}` : '';
        if (prev.duo !== duo) el.dataset.duo = prev.duo = duo;
      }
      // 遊ぶ絵にはボールが描かれているので、そのあいだ部屋のボールは隠す
      if (ballRef.current) ballRef.current.style.visibility = ballHeld ? 'hidden' : '';
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
  }, [world]);

  useImperativeHandle(ref, () => ({
    eat: (ids) => {
      const now = performance.now();
      ids.forEach((id, i) => actors.current.get(id)?.feed(now, world, i));
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
            ref={key === 'ball' ? ballRef : undefined}
            className={`room-item${key === 'bowl' ? ' tappable' : ''}${fresh.includes(key) ? ' fresh' : ''}`}
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
              onClick={() => actors.current.get(p.id)?.poke(performance.now(), world)}
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
