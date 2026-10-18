/** 保存の失敗を、利用者に分かる言葉にする */
export function saveErrorText(e: unknown) {
  const err = e as { name?: string; message?: string; inner?: { name?: string } };
  const text = `${err?.name ?? ''} ${err?.inner?.name ?? ''} ${err?.message ?? ''}`;
  if (/quota/i.test(text)) return 'iPad の空き容量が足りません。不要な参考書を削除するか、写真などを整理してください';
  return err?.message || String(e);
}
