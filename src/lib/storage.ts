import { useEffect, useState } from 'react';

export interface Space {
  /** このアプリが使っている量 */
  usage: number;
  /** このアプリが使える上限 */
  quota: number;
  free: number;
}

/** 保存できる容量（ブラウザが教えてくれないときは null） */
export async function storageSpace(): Promise<Space | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e?.quota) return null;
    const usage = e.usage ?? 0;
    return { usage, quota: e.quota, free: Math.max(0, e.quota - usage) };
  } catch {
    return null;
  }
}

export function useStorageSpace() {
  const [space, setSpace] = useState<Space | null>(null);
  useEffect(() => {
    storageSpace().then(setSpace);
  }, []);
  return space;
}
