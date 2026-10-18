import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { db } from '../db';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy };

/** 開いている参考書（最近使った順）。メモリを使いすぎないよう、同時に持つのは MAX_OPEN 冊まで */
const cache = new Map<string, Promise<PDFDocumentProxy>>();
/** 保存されている参考書の中身が読めなくなっているとき（以前の版で復元した参考書など） */
export const BOOK_UNREADABLE = '参考書のデータが読めなくなっています';
const MAX_OPEN = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 保存されている参考書の中身を読む。
 * iPad では、追加した直後の PDF はまだ書き込み中で読めないことがあるので、少し待って読み直す
 */
async function readBookData(bookId: string): Promise<{ data: Uint8Array; pageCount?: number }> {
  for (const wait of [0, 300, 1000, 2000, 4000]) {
    if (wait) await sleep(wait);
    const book = await db.books.get(bookId);
    if (!book) throw new Error('参考書が見つかりません（削除された可能性があります）');
    try {
      return { data: new Uint8Array(await book.file.arrayBuffer()), pageCount: book.pageCount };
    } catch {
      // 読み直す
    }
  }
  throw new Error(BOOK_UNREADABLE);
}

async function openBook(bookId: string): Promise<PDFDocumentProxy> {
  const book = await readBookData(bookId);
  const data = book.data;
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
  }).promise;
  if (book.pageCount !== doc.numPages) db.books.update(bookId, { pageCount: doc.numPages });
  return doc;
}

/** 参考書の PDF を読み込む（同じ参考書は使い回す） */
export function loadBookPdf(bookId: string): Promise<PDFDocumentProxy> {
  let p = cache.get(bookId);
  if (p) {
    // 最近使ったものとして並べ直す
    cache.delete(bookId);
    cache.set(bookId, p);
    return p;
  }
  p = openBook(bookId);
  p.catch(() => cache.delete(bookId));
  cache.set(bookId, p);
  // 古いものから閉じる
  for (const id of cache.keys()) {
    if (cache.size <= MAX_OPEN) break;
    if (id !== bookId) forgetBookPdf(id);
  }
  return p;
}

export function forgetBookPdf(bookId: string) {
  const p = cache.get(bookId);
  cache.delete(bookId);
  p?.then((d) => d.destroy()).catch(() => {});
}

/** 開いている参考書をすべて閉じる（バインダーを閉じたとき） */
export function forgetAllPdfs() {
  for (const id of [...cache.keys()]) forgetBookPdf(id);
}

let coverQueue: Promise<unknown> = Promise.resolve();

/** 表紙のサムネイルを生成（1 冊ずつ順番に。開いていない参考書は描いたらすぐ閉じる） */
export function renderCover(bookId: string, width = 160): Promise<string> {
  const run = async () => {
    const cached = cache.get(bookId);
    const doc = cached ? await cached : await openBook(bookId);
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
      const url = canvas.toDataURL('image/jpeg', 0.8);
      canvas.width = canvas.height = 0;
      return url;
    } finally {
      if (!cached) doc.destroy();
    }
  };
  const p = coverQueue.then(run, run);
  coverQueue = p.catch(() => {});
  return p;
}

export interface OutlineItem {
  title: string;
  page: number | null;
  items: OutlineItem[];
}

/** PDF 内の飛び先（名前付き / 直接指定）をページ番号にする */
async function resolveDest(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : (dest as unknown[]);
    if (!explicit || !explicit[0]) return null;
    const ref = explicit[0];
    if (typeof ref === 'number') return ref + 1;
    return (await doc.getPageIndex(ref as never)) + 1;
  } catch {
    return null;
  }
}

export async function getOutline(doc: PDFDocumentProxy): Promise<OutlineItem[]> {
  const raw = await doc.getOutline();
  if (!raw) return [];
  const resolve = (dest: unknown) => resolveDest(doc, dest);
  const walk = async (items: typeof raw): Promise<OutlineItem[]> =>
    Promise.all(items.map(async (it) => ({ title: it.title, page: await resolve(it.dest), items: await walk(it.items ?? []) })));
  return walk(raw);
}

const textCache = new WeakMap<PDFDocumentProxy, Promise<string[]>>();
const textListeners = new WeakMap<PDFDocumentProxy, Set<(done: number, total: number) => void>>();

/** 全ページのテキスト（検索用）。初回は全ページを読むので、進み具合を onProgress で知らせる */
export function getAllText(doc: PDFDocumentProxy, onProgress?: (done: number, total: number) => void): Promise<string[]> {
  let listeners = textListeners.get(doc);
  if (!listeners) textListeners.set(doc, (listeners = new Set()));
  if (onProgress) listeners.add(onProgress);
  let p = textCache.get(doc);
  if (!p) {
    const ls = listeners;
    p = (async () => {
      const out: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        out.push(tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join(''));
        page.cleanup();
        if (i % 5 === 0 || i === doc.numPages) ls.forEach((f) => f(i, doc.numPages));
      }
      return out;
    })();
    p.catch(() => textCache.delete(doc));
    textCache.set(doc, p);
  }
  if (onProgress) p.finally(() => listeners!.delete(onProgress)).catch(() => {});
  return p;
}

/** ページ内のリンク（目次の項目など）。rect は PDF の座標 */
export interface PageLink {
  rect: [number, number, number, number];
  page?: number;
  url?: string;
}

const linkCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageLink[]>>>();

export function getPageLinks(doc: PDFDocumentProxy, pageNumber: number): Promise<PageLink[]> {
  let m = linkCache.get(doc);
  if (!m) linkCache.set(doc, (m = new Map()));
  let p = m.get(pageNumber);
  if (!p) {
    p = (async () => {
      const page = await doc.getPage(pageNumber);
      const annots = await page.getAnnotations({ intent: 'display' });
      const out: PageLink[] = [];
      for (const a of annots) {
        if (a.subtype !== 'Link' || !a.rect) continue;
        if (a.dest) {
          const target = await resolveDest(doc, a.dest);
          if (target) out.push({ rect: a.rect, page: target });
        } else if (a.url && /^https?:/i.test(a.url)) out.push({ rect: a.rect, url: a.url });
      }
      return out;
    })().catch(() => []);
    m.set(pageNumber, p);
  }
  return p;
}
