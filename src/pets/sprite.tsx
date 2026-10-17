import type { CSSProperties } from 'react';
import assets from './assets.json';

export interface AnimDef {
  file: string;
  frames: number;
  frameMs: number;
  loop: boolean;
  /** 再生するコマの順番（無ければ 0, 1, 2…） */
  sequence?: number[];
  returnTo?: string;
  /** 画像の中にボールが描かれている（部屋のボールを隠す） */
  hidesBall?: boolean;
}

export const CELL = assets.cell;
/** 足元の位置（1 コマの中のピクセル） */
export const ANCHOR = assets.anchor as [number, number];
export interface RoomItem {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 床に接している高さ。これが大きい（手前の）ものほど上に描く */
  groundY: number;
}
export const ROOM = assets.room as { width: number; height: number; background: string; items: Record<string, RoomItem> };

const pets = assets.pets as Record<string, { animations: Record<string, AnimDef> }>;

export const assetUrl = (path: string) => `${import.meta.env.BASE_URL}assets/${path}`;

/** その種類のアニメーション。無いときは待機の静止画で代用する */
export function animOf(species: string, name: string): AnimDef {
  const a = pets[species]?.animations;
  return a?.[name] ?? a?.idle ?? { file: '', frames: 1, frameMs: 1000, loop: true };
}

/** 再生 n コマ目に表示する画像の番号 */
export function frameAt(def: AnimDef, step: number) {
  const seq = def.sequence;
  const len = seq ? seq.length : def.frames;
  const i = def.loop ? step % len : Math.min(step, len - 1);
  return seq ? seq[i] : i;
}

/** スプライトシートの 1 コマを表示する。size は表示する 1 コマの大きさ（px） */
export function Sprite({ species, anim = 'idle', frame = 0, size, className, style }: { species: string; anim?: string; frame?: number; size: number; className?: string; style?: CSSProperties }) {
  const def = animOf(species, anim);
  return (
    <div
      className={`sprite${className ? ` ${className}` : ''}`}
      style={{
        width: size,
        height: size,
        backgroundImage: def.file ? `url(${assetUrl(`pets/${def.file}`)})` : undefined,
        backgroundSize: `${def.frames * size}px ${size}px`,
        backgroundPosition: `${-frame * size}px 0`,
        ...style,
      }}
    />
  );
}
