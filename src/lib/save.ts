/** ファイル名に使えない文字（/ \ : * ? " < > | など）を置き換える */
export function safeFileName(name: string, fallback = 'note') {
  const s = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);
  return s || fallback;
}

export type SaveResult = 'shared' | 'downloaded' | 'cancelled';

/**
 * ファイルを端末に保存する。
 * iPad（指で操作する端末）は共有シートを出して「“ファイル”に保存」を選べるようにする。
 * ホーム画面のアプリではダウンロードが使えないことがあるため。
 * 共有シートはタップの直後に呼ぶこと（時間がたつと iPad が開かせない）
 */
export async function saveFile(file: File): Promise<SaveResult> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (matchMedia('(pointer: coarse)').matches && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
      // 共有できなかったときはダウンロードにする
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  // すぐ無効にするとダウンロードが始まらないことがあるので、少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
