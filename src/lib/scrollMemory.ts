import { useEffect, type RefObject } from 'react';

/**
 * ノートごとのスクロール位置を覚えておき、開き直したとき（ペットの部屋から戻ったときなど）に戻す。
 * アプリを読み込み直しても残るよう sessionStorage にも置く
 */
const STORAGE_KEY = 'study-sakura:scroll';
type Pos = { top: number; left: number };

const memory: Map<string, Pos> = (() => {
  try {
    return new Map(Object.entries(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Pos>));
  } catch {
    return new Map();
  }
})();

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(memory)));
    } catch {
      /* 保存できなくても動作は続ける */
    }
  }, 300);
}

/** ready になった（中身の高さが決まった）ときに位置を戻し、以後スクロールのたびに覚える */
export function useScrollMemory(ref: RefObject<HTMLElement>, key: string, ready = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    const saved = memory.get(key);
    let raf = 0;
    if (saved) {
      // 中身が描かれてから戻す
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          el.scrollTop = saved.top;
          el.scrollLeft = saved.left;
        });
      });
    }
    // 閉じるときには要素が外れて位置が 0 になることがあるので、スクロールしたときだけ覚える
    const onScroll = () => {
      memory.set(key, { top: el.scrollTop, left: el.scrollLeft });
      persist();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
    };
  }, [ref, key, ready]);
}
