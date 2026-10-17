import type { MarkerName } from './settings';

/** マーカーの色（テキストノート / 手書きノート） */
export const MARKERS: { name: MarkerName; label: string; text: string; ink: string }[] = [
  { name: 'yellow', label: '黄', text: '#fff176', ink: '#ffe94d' },
  { name: 'pink', label: 'ピンク', text: '#ffb3c8', ink: '#ff8fb1' },
  { name: 'green', label: '緑', text: '#b9f6ca', ink: '#7ee8a2' },
  { name: 'blue', label: '青', text: '#b3e5fc', ink: '#7cc7ff' },
  { name: 'orange', label: 'オレンジ', text: '#ffcc80', ink: '#ffb74d' },
];

/** 暗記シートで隠す赤系のペン色 */
export const RED_PENS = ['#d32f2f', '#ef6c00'];

export const markerByInkColor = (c: string) => MARKERS.find((m) => m.ink === c)?.name;
