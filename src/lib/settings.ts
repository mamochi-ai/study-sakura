import { useEffect, useState } from 'react';

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  pomodoroWork: number;
  pomodoroBreak: number;
  noteFontSize: number;
  /** ノートを開くと、そのノートで最後に見ていたページへ移動する */
  syncNotePage: boolean;
  /** 新しいノートの用紙 */
  defaultPaper: 'plain' | 'lined' | 'grid' | 'dots';
  /** 暗記シートで隠すもの */
  hideRed: boolean;
  hideMarkers: MarkerName[];
  /** 画面全体をピンチで拡大できるようにする（見えにくいとき用。ふだんは誤操作を防ぐため止める） */
  allowPageZoom: boolean;
}

export type MarkerName = 'yellow' | 'pink' | 'green' | 'blue' | 'orange';

const KEY = 'study-sakura:settings';
const defaults: Settings = { theme: 'system', pomodoroWork: 25, pomodoroBreak: 5, noteFontSize: 16, syncNotePage: true, defaultPaper: 'lined', hideRed: true, hideMarkers: ['yellow', 'green'], allowPageZoom: false };

let state: Settings = (() => {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return defaults;
  }
})();
const listeners = new Set<(s: Settings) => void>();

export function getSettings() {
  return state;
}

export function updateSettings(patch: Partial<Settings>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 保存できなくても動作は続ける */
  }
  listeners.forEach((l) => l(state));
}

export function useSettings(): Settings {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

export function applyTheme(theme: Settings['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
