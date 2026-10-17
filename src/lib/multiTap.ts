import { useEffect, useRef, type RefObject } from 'react';

/** 2 本指 / 3 本指で軽くタップしたかを判定する（GoodNotes などと同じ操作） */
export class MultiTap {
  private max = 0;
  private t0 = 0;
  private x0 = 0;
  private y0 = 0;
  private moved = false;

  start(e: TouchEvent) {
    // 最初の指が触れたときに数え始める
    if (e.touches.length === e.changedTouches.length) {
      this.max = 0;
      this.t0 = performance.now();
      this.moved = false;
      const t = e.touches[0];
      this.x0 = t.clientX;
      this.y0 = t.clientY;
    }
    this.max = Math.max(this.max, e.touches.length);
  }

  move(e: TouchEvent) {
    const t = e.touches[0];
    if (t && Math.hypot(t.clientX - this.x0, t.clientY - this.y0) > 12) this.moved = true;
  }

  cancel() {
    this.max = 0;
  }

  /** すべての指が離れたら 2 / 3（タップでなければ 0）を返す */
  end(e: TouchEvent): 0 | 2 | 3 {
    if (e.touches.length > 0) return 0;
    const n = this.max;
    this.max = 0;
    if (this.moved || performance.now() - this.t0 > 400) return 0;
    return n === 2 ? 2 : n === 3 ? 3 : 0;
  }
}

/** 要素の上で 2 本指タップ → 元に戻す、3 本指タップ → やり直す */
export function useMultiTapUndo(ref: RefObject<HTMLElement>, onUndo: () => void, onRedo: () => void) {
  const cb = useRef({ onUndo, onRedo });
  cb.current = { onUndo, onRedo };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mt = new MultiTap();
    const start = (e: TouchEvent) => mt.start(e);
    const move = (e: TouchEvent) => mt.move(e);
    const end = (e: TouchEvent) => {
      const n = mt.end(e);
      if (n === 2) cb.current.onUndo();
      else if (n === 3) cb.current.onRedo();
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', () => mt.cancel());
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
    };
  }, [ref]);
}
