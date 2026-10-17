import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { db } from '../db';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy };

const cache = new Map<string, Promise<PDFDocumentProxy>>();

/** 参考書の PDF を読み込む（同じ参考書は使い回す） */
export function loadBookPdf(bookId: string): Promise<PDFDocumentProxy> {
  let p = cache.get(bookId);
  if (!p) {
    p = (async () => {
      const book = await db.books.get(bookId);
      if (!book) throw new Error('参考書が見つかりません');
      const data = new Uint8Array(await book.file.arrayBuffer());
      const doc = await pdfjs.getDocument({
        data,
        cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
      }).promise;
      if (book.pageCount !== doc.numPages) db.books.update(bookId, { pageCount: doc.numPages });
      return doc;
    })();
    p.catch(() => cache.delete(bookId));
    cache.set(bookId, p);
  }
  return p;
}

export function forgetBookPdf(bookId: string) {
  const p = cache.get(bookId);
  cache.delete(bookId);
  p?.then((d) => d.destroy()).catch(() => {});
}

/** 表紙のサムネイルを生成 */
export async function renderCover(bookId: string, width = 160): Promise<string> {
  const doc = await loadBookPdf(bookId);
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.8);
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

/** 全ページのテキスト（検索用） */
export function getAllText(doc: PDFDocumentProxy): Promise<string[]> {
  let p = textCache.get(doc);
  if (!p) {
    p = (async () => {
      const out: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        out.push(tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join(''));
      }
      return out;
    })();
    textCache.set(doc, p);
  }
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
