import Dexie, { type Table } from 'dexie';
import type { JSONContent } from '@tiptap/react';

/** 本棚に並ぶ参考書（PDF） */
export interface Book {
  id: string;
  title: string;
  color: string;
  file: Blob;
  fileName: string;
  size: number;
  pageCount?: number;
  createdAt: number;
  lastOpenedAt?: number;
}

/** 参考書ごとの読書位置（バインダー単位で記憶） */
export interface ReadingPosition {
  page: number;
  zoom: number | 'fit';
}

/** 参考書とノートをセットで束ねるバインダー */
export interface Binder {
  id: string;
  title: string;
  color: string;
  bookIds: string[];
  activeBookId?: string;
  lastNoteId?: string;
  positions: Record<string, ReadingPosition>;
  splitRatio: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
}

export type NoteKind = 'text' | 'ink';
export type Paper = 'plain' | 'lined' | 'grid' | 'dots';

export interface Note {
  id: string;
  binderId: string;
  title: string;
  /** テキストノート / 手書きノート（未設定はテキスト） */
  kind?: NoteKind;
  /** 用紙（未設定は設定画面の既定値） */
  paper?: Paper;
  content: JSONContent | null;
  /** 検索用のプレーンテキスト */
  text: string;
  order: number;
  /** このノートを開いたときに表示する参考書とページ */
  bookId?: string;
  page?: number;
  createdAt: number;
  updatedAt: number;
}

/** 手書きの 1 画。座標は用紙の幅を 1000 とした論理座標 */
export interface Stroke {
  id: string;
  noteId: string;
  tool: 'pen' | 'marker';
  color: string;
  /** 論理座標での線の太さ */
  width: number;
  /** [x, y, 筆圧, x, y, 筆圧, …] */
  points: number[];
  createdAt: number;
}

/** 手書きノートに置く画像・引用・ページリンク・復習マーク（論理座標） */
export interface InkItem {
  id: string;
  noteId: string;
  kind: 'image' | 'quote' | 'pageRef' | 'mark';
  x: number;
  y: number;
  /** 画像・引用の幅（論理座標） */
  w?: number;
  /** 画像の高さ（論理座標） */
  h?: number;
  src?: string;
  text?: string;
  bookId?: string;
  page?: number;
  label?: string;
  reviewId?: string;
  createdAt: number;
}

export type ReviewStatus = 'todo' | 'doing' | 'done';
export const REVIEW_STATUS: Record<ReviewStatus, { label: string; color: string }> = {
  todo: { label: '未理解', color: '#e05252' },
  doing: { label: '復習中', color: '#f0a020' },
  done: { label: '理解済み', color: '#3fa565' },
};

/** 復習マーク */
export interface Review {
  id: string;
  binderId: string;
  noteId: string;
  /** マークを付けたときに開いていた参考書とページ */
  bookId?: string;
  page?: number;
  /** 手書きノート内の位置（論理座標） */
  y?: number;
  memo: string;
  status: ReviewStatus;
  createdAt: number;
  updatedAt: number;
}

/** 参考書のしおり */
export interface Bookmark {
  id: string;
  bookId: string;
  page: number;
  label: string;
  createdAt: number;
}

/** 学習時間の記録 */
export interface StudySession {
  id: string;
  binderId: string;
  date: string;
  seconds: number;
  startedAt: number;
}

class StudyDB extends Dexie {
  books!: Table<Book, string>;
  binders!: Table<Binder, string>;
  notes!: Table<Note, string>;
  bookmarks!: Table<Bookmark, string>;
  sessions!: Table<StudySession, string>;
  strokes!: Table<Stroke, string>;
  inkItems!: Table<InkItem, string>;
  reviews!: Table<Review, string>;

  constructor() {
    // 保存データの名前は変えない（変えると既存のノートが読めなくなる）
    super('study-sakura');
    this.version(1).stores({
      books: 'id, createdAt, lastOpenedAt',
      binders: 'id, createdAt, lastOpenedAt',
      notes: 'id, binderId, [binderId+order], updatedAt',
      bookmarks: 'id, bookId',
      sessions: 'id, binderId, date',
    });
    this.version(2).stores({ strokes: 'id, noteId' });
    this.version(3).stores({ inkItems: 'id, noteId', reviews: 'id, binderId, noteId, status' });
  }
}

export const db = new StudyDB();

export const uid = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export const today = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const BOOK_COLORS = ['#3b5b8c', '#8c3b3b', '#2f6b4f', '#6b4f8c', '#b0782a', '#2a7b8c', '#555c66', '#8c5a3b'];
export const BINDER_COLORS = ['#e0607e', '#f2a541', '#5aa469', '#4f86c6', '#9b6fc7', '#e07a5f', '#3d9ca8', '#7a7a7a'];

export async function addBook(file: File): Promise<Book> {
  const count = await db.books.count();
  const book: Book = {
    id: uid(),
    title: file.name.replace(/\.pdf$/i, ''),
    color: BOOK_COLORS[count % BOOK_COLORS.length],
    file,
    fileName: file.name,
    size: file.size,
    createdAt: Date.now(),
  };
  await db.books.add(book);
  return book;
}

export async function deleteBook(bookId: string) {
  await db.transaction('rw', db.books, db.binders, db.bookmarks, async () => {
    await db.books.delete(bookId);
    await db.bookmarks.where('bookId').equals(bookId).delete();
    await db.binders.toCollection().modify((b) => {
      b.bookIds = b.bookIds.filter((id) => id !== bookId);
      delete b.positions[bookId];
      if (b.activeBookId === bookId) b.activeBookId = b.bookIds[0];
    });
  });
}

export async function createBinder(title: string, color: string, bookIds: string[]): Promise<Binder> {
  const now = Date.now();
  const binder: Binder = {
    id: uid(),
    title,
    color,
    bookIds,
    activeBookId: bookIds[0],
    positions: {},
    splitRatio: 0.5,
    createdAt: now,
    updatedAt: now,
  };
  const note = newNote(binder.id, 0, 'はじめてのノート');
  binder.lastNoteId = note.id;
  await db.transaction('rw', db.binders, db.notes, async () => {
    await db.binders.add(binder);
    await db.notes.add(note);
  });
  return binder;
}

export async function deleteBinder(binderId: string) {
  await db.transaction('rw', [db.binders, db.notes, db.sessions, db.strokes, db.inkItems, db.reviews], async () => {
    await db.binders.delete(binderId);
    const noteIds = (await db.notes.where('binderId').equals(binderId).primaryKeys()) as string[];
    await db.strokes.where('noteId').anyOf(noteIds).delete();
    await db.inkItems.where('noteId').anyOf(noteIds).delete();
    await db.reviews.where('binderId').equals(binderId).delete();
    await db.notes.where('binderId').equals(binderId).delete();
    await db.sessions.where('binderId').equals(binderId).delete();
  });
}

export function newNote(binderId: string, order: number, title = '無題のノート'): Note {
  const now = Date.now();
  return { id: uid(), binderId, title, content: null, text: '', order, createdAt: now, updatedAt: now };
}

export async function addNote(binderId: string, init?: Partial<Note>): Promise<Note> {
  const last = await db.notes.where('[binderId+order]').between([binderId, Dexie.minKey], [binderId, Dexie.maxKey]).last();
  const note = { ...newNote(binderId, (last?.order ?? -1) + 1), ...init };
  await db.notes.add(note);
  return note;
}

export async function addStudyTime(binderId: string, seconds: number, startedAt: number) {
  const date = today(new Date(startedAt));
  const id = `${binderId}:${date}`;
  const existing = await db.sessions.get(id);
  if (existing) await db.sessions.update(id, { seconds: existing.seconds + seconds });
  else await db.sessions.add({ id, binderId, date, seconds, startedAt });
}

export async function deleteNote(noteId: string) {
  await db.transaction('rw', [db.notes, db.strokes, db.inkItems, db.reviews], async () => {
    await db.notes.delete(noteId);
    await db.strokes.where('noteId').equals(noteId).delete();
    await db.inkItems.where('noteId').equals(noteId).delete();
    await db.reviews.where('noteId').equals(noteId).delete();
  });
}

export async function duplicateNote(note: Note): Promise<Note> {
  const copy = await addNote(note.binderId, {
    title: `${note.title}（コピー）`,
    kind: note.kind,
    paper: note.paper,
    content: note.content,
    text: note.text,
    bookId: note.bookId,
    page: note.page,
  });
  const strokes = await db.strokes.where('noteId').equals(note.id).toArray();
  if (strokes.length) await db.strokes.bulkAdd(strokes.map((s) => ({ ...s, id: uid(), noteId: copy.id })));
  // 復習マークは複製しない（同じマークが 2 つ並ぶと紛らわしいため）
  const items = (await db.inkItems.where('noteId').equals(note.id).toArray()).filter((i) => i.kind !== 'mark');
  if (items.length) await db.inkItems.bulkAdd(items.map((i) => ({ ...i, id: uid(), noteId: copy.id })));
  return copy;
}

export async function createReview(init: Omit<Review, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'memo'> & { memo?: string }): Promise<Review> {
  const now = Date.now();
  const r: Review = { memo: '', status: 'todo', ...init, id: uid(), createdAt: now, updatedAt: now };
  await db.reviews.add(r);
  return r;
}
