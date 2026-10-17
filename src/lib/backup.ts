import { db, type Book } from '../db';

// 形式名は旧名のまま（以前のバックアップも復元できるように）
const FORMAT = 'study-sakura-backup';

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) s += String.fromCharCode(...buf.subarray(i, i + chunk));
  return btoa(s);
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** すべてのデータ（参考書 PDF を含む）を 1 つのファイルに書き出す */
export async function exportBackup() {
  const [books, binders, notes, bookmarks, sessions, strokes, inkItems, reviews, pets, petWorld] = await Promise.all([
    db.books.toArray(),
    db.binders.toArray(),
    db.notes.toArray(),
    db.bookmarks.toArray(),
    db.sessions.toArray(),
    db.strokes.toArray(),
    db.inkItems.toArray(),
    db.reviews.toArray(),
    db.pets.toArray(),
    db.petWorld.toArray(),
  ]);
  const encodedBooks = await Promise.all(
    books.map(async ({ file, ...rest }) => ({ ...rest, fileType: file.type || 'application/pdf', data: await blobToBase64(file) })),
  );
  const payload = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), books: encodedBooks, binders, notes, bookmarks, sessions, strokes, inkItems, reviews, pets, petWorld };
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `my-study-${stamp}.json`);
}

/** バックアップを読み込む。同じ ID のデータは上書きされる */
export async function importBackup(file: File) {
  const payload = JSON.parse(await file.text());
  if (payload?.format !== FORMAT) throw new Error('My Study のバックアップファイルではありません');
  const books: Book[] = payload.books.map(({ data, fileType, ...rest }: { data: string; fileType: string } & Omit<Book, 'file'>) => ({
    ...rest,
    file: base64ToBlob(data, fileType),
  }));
  await db.transaction('rw', [db.books, db.binders, db.notes, db.bookmarks, db.sessions, db.strokes, db.inkItems, db.reviews, db.pets, db.petWorld], async () => {
    await db.books.bulkPut(books);
    await db.binders.bulkPut(payload.binders ?? []);
    await db.notes.bulkPut(payload.notes ?? []);
    await db.bookmarks.bulkPut(payload.bookmarks ?? []);
    await db.sessions.bulkPut(payload.sessions ?? []);
    await db.strokes.bulkPut(payload.strokes ?? []);
    await db.inkItems.bulkPut(payload.inkItems ?? []);
    await db.reviews.bulkPut(payload.reviews ?? []);
    await db.pets.bulkPut(payload.pets ?? []);
    await db.petWorld.bulkPut(payload.petWorld ?? []);
  });
  return { books: books.length, binders: payload.binders?.length ?? 0, notes: payload.notes?.length ?? 0 };
}
