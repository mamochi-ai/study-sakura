import { db, type Binder, type Book, type Bookmark, type InkItem, type Note, type Pet, type PetWorld, type Review, type Stroke, type StudySession } from '../db';
import { hasBookBytes, putBookBytes, readBookBytes } from './bookData';
import { buildZip, readZip } from './zip';

// 形式名は旧名のまま（以前のバックアップも復元できるように）
const FORMAT = 'study-sakura-backup';
/** 2：ZIP（中に data.json と books/<id>.pdf）。1：参考書を Base64 で入れた JSON（読み込みだけ対応） */
const VERSION = 2;
const DATA_FILE = 'data.json';
const bookPath = (id: string) => `books/${id}.pdf`;

export type BackupKind = 'full' | 'notes';

/** 参考書以外のデータ（参考書は中身を除いた情報だけ） */
interface Payload {
  format: string;
  version: number;
  exportedAt: string;
  /** 参考書の PDF も入っているか */
  includesBooks: boolean;
  books: (Omit<Book, 'file'> & { fileType?: string; data?: string })[];
  binders: Binder[];
  notes: Note[];
  bookmarks: Bookmark[];
  sessions: StudySession[];
  strokes: Stroke[];
  inkItems: InkItem[];
  reviews: Review[];
  pets: Pet[];
  petWorld: PetWorld[];
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * バックアップのファイルを作る。
 * full：参考書の PDF も含む／notes：ノート・手書き・学習記録・ペットなど（参考書の PDF は含まない。軽い）
 */
export async function createBackup(kind: BackupKind, onProgress?: (ratio: number) => void): Promise<File> {
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
  const payload: Payload = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    includesBooks: kind === 'full',
    books: books.map(({ file, ...rest }) => ({ ...rest, fileType: file.type || 'application/pdf' })),
    binders,
    notes,
    bookmarks,
    sessions,
    strokes,
    inkItems,
    reviews,
    pets,
    petWorld,
  };
  const entries = [{ name: DATA_FILE, data: new Blob([JSON.stringify(payload)], { type: 'application/json' }) }];
  if (kind === 'full')
    for (const b of books) {
      try {
        entries.push({ name: bookPath(b.id), data: new Blob([await readBookBytes(b.id)], { type: 'application/pdf' }) });
      } catch {
        // 読めない参考書は入れない（ノートなどは書き出す）
      }
    }
  const zip = await buildZip(entries, onProgress);
  return new File([zip], `my-study-${kind === 'full' ? '' : 'notes-'}${stamp()}.zip`, { type: 'application/zip' });
}

/** バックアップのファイルを読む（新しい ZIP と、以前の JSON の両方） */
async function readBackup(file: File): Promise<{ payload: Payload; pdfs: Map<string, Blob> }> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  let payload: Payload;
  const pdfs = new Map<string, Blob>();
  if (isZip) {
    const files = await readZip(file);
    const data = files.get(DATA_FILE);
    if (!data) throw new Error('My Study のバックアップファイルではありません');
    payload = JSON.parse(await data.text());
    for (const b of payload?.books ?? []) {
      const pdf = files.get(bookPath(b.id));
      if (pdf) pdfs.set(b.id, new Blob([pdf], { type: b.fileType || 'application/pdf' }));
    }
  } else {
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw new Error('My Study のバックアップファイルではありません');
    }
    // 以前の形式：参考書は Base64 で入っている
    for (const b of payload?.books ?? []) if (b.data) pdfs.set(b.id, base64ToBlob(b.data, b.fileType || 'application/pdf'));
  }
  if (payload?.format !== FORMAT) throw new Error('My Study のバックアップファイルではありません');
  if (typeof payload.version === 'number' && payload.version > VERSION) {
    throw new Error('新しいバージョンのアプリで作られたバックアップです。アプリを更新してから復元してください');
  }
  return { payload, pdfs };
}

export interface RestoreResult {
  /** 追加・更新したもの */
  books: number;
  binders: number;
  notes: number;
  /** バックアップより新しかったので、今のまま残したもの */
  kept: number;
  /** バックアップに PDF が入っていなかった参考書（ノートだけのバックアップから、別の端末に復元したとき） */
  missingBooks: number;
}

/**
 * バックアップから復元する。今あるデータは消さずに合わせる：
 * - 同じものがあれば、新しいほう（更新日時・学習時間が多いほう）を残す
 * - ペットの累積学習時間・使った餌の数は多いほう、解放した家具は合わせる
 */
export async function restoreBackup(file: File): Promise<RestoreResult> {
  const { payload, pdfs } = await readBackup(file);
  const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  const r: RestoreResult = { books: 0, binders: 0, notes: 0, kept: 0, missingBooks: 0 };

  // 参考書は 1 冊ずつ、中身をアプリの中に写してから保存する。
  // 選んだファイルの一部を指したまま保存すると、iPad ではそのファイル（一時的な置き場所）が消えたあと読めなくなるため
  for (const { data: _data, fileType: _type, ...meta } of list(payload.books)) {
    const cur = await db.books.get(meta.id);
    if (cur && (await hasBookBytes(meta.id))) continue;
    const pdf = pdfs.get(meta.id);
    if (!pdf) {
      r.missingBooks++;
      continue;
    }
    const data = await pdf.arrayBuffer();
    await db.transaction('rw', db.books, db.bookData, async () => {
      await db.books.put({ ...meta, file: new Blob([], { type: pdf.type || 'application/pdf' }) });
      await putBookBytes(meta.id, data);
    });
    r.books++;
  }

  await db.transaction('rw', [db.binders, db.notes, db.bookmarks, db.sessions, db.strokes, db.inkItems, db.reviews, db.pets, db.petWorld], async () => {
    /** 更新日時が新しいほうを残す */
    const newer = async <T extends { id: string; updatedAt: number }>(table: typeof db.binders | typeof db.notes | typeof db.reviews, rows: T[], count?: 'binders' | 'notes') => {
      for (const row of rows) {
        const cur = (await table.get(row.id)) as T | undefined;
        if (cur && (cur.updatedAt ?? 0) >= (row.updatedAt ?? 0)) {
          if (cur.updatedAt !== row.updatedAt) r.kept++;
          continue;
        }
        await (table as unknown as { put: (v: T) => Promise<unknown> }).put(row);
        if (count) r[count]++;
      }
    };
    await newer(db.binders, list(payload.binders), 'binders');
    await newer(db.notes, list(payload.notes), 'notes');
    await newer(db.reviews, list(payload.reviews));
    /** 無いものだけ足す（あとから変わらないもの・今のほうが新しいもの） */
    const missing = async <T extends { id: string }>(table: { get: (id: string) => Promise<T | undefined>; add: (v: T) => Promise<unknown> }, rows: T[]) => {
      for (const row of rows) if (!(await table.get(row.id))) await table.add(row);
    };
    await missing(db.bookmarks, list(payload.bookmarks));
    await missing(db.strokes, list(payload.strokes));
    await missing(db.inkItems, list(payload.inkItems));
    await missing(db.pets, list(payload.pets));
    // 学習時間は多いほう（今日の記録が古い値に戻らないように）
    for (const s of list(payload.sessions)) {
      const cur = await db.sessions.get(s.id);
      if (!cur || cur.seconds < s.seconds) await db.sessions.put(s);
    }
    for (const w of list(payload.petWorld)) {
      const cur = await db.petWorld.get(w.id);
      if (!cur) await db.petWorld.add(w);
      else
        await db.petWorld.put({
          ...cur,
          studySeconds: Math.max(cur.studySeconds, w.studySeconds),
          foodSpent: Math.max(cur.foodSpent, w.foodSpent),
          unlocked: [...new Set([...cur.unlocked, ...w.unlocked])],
          miniPetId: cur.miniPetId ?? w.miniPetId,
          updatedAt: Math.max(cur.updatedAt, w.updatedAt),
        });
    }
  });
  return r;
}
