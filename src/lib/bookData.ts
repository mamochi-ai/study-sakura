import { db } from '../db';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 保存されている参考書の中身が読めなくなっているとき */
export const BOOK_UNREADABLE = '参考書のデータが読めなくなっています';

/**
 * 参考書の PDF の中身を読む（毎回新しい ArrayBuffer を返すので、pdf.js に渡してよい）。
 * 以前の版で Blob のまま保存した参考書は、ここで読めたときに bookData へ移す。
 * Blob は書き込み直後などに読めないことがあるので、少し待って読み直す
 */
export async function readBookBytes(bookId: string): Promise<ArrayBuffer> {
  for (const wait of [0, 300, 1000, 2000, 4000]) {
    if (wait) await sleep(wait);
    const row = await db.bookData.get(bookId);
    if (row) return row.data;
    const book = await db.books.get(bookId);
    if (!book) throw new Error('参考書が見つかりません（削除された可能性があります）');
    let data: ArrayBuffer;
    try {
      data = await book.file.arrayBuffer();
    } catch {
      continue;
    }
    if (!data.byteLength) continue;
    try {
      // 移したら、元の Blob は空にして容量を空ける
      await db.transaction('rw', db.books, db.bookData, async () => {
        await db.bookData.put({ id: bookId, data: data.slice(0) });
        await db.books.update(bookId, { file: new Blob([], { type: book.file.type || 'application/pdf' }) });
      });
    } catch {
      // 移せなくても（容量不足など）、今回は読めた中身を使う
    }
    return data;
  }
  throw new Error(BOOK_UNREADABLE);
}

/** 参考書の中身を保存する */
export async function putBookBytes(bookId: string, data: ArrayBuffer) {
  await db.bookData.put({ id: bookId, data });
}

/** 参考書の中身が読めるか（bookData にあるか、以前の Blob が読めるか） */
export async function hasBookBytes(bookId: string) {
  if (await db.bookData.get(bookId)) return true;
  const book = await db.books.get(bookId);
  if (!book || !book.file.size) return false;
  try {
    await book.file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}
