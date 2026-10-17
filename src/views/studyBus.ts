import type { Editor } from '@tiptap/core';
import { createContext, useContext } from 'react';

/** PDF 側とノート側をつなぐ連絡口 */
export interface StudyBus {
  /** 参考書を指定ページで開く */
  openPage: (bookId: string, page: number) => void;
  /** 今表示している参考書とページ */
  current: () => { bookId: string; page: number } | null;
  bookTitle: (bookId: string) => string;
  editor: Editor | null;
  /** 手書きノートを開いているときの差し込み口 */
  ink: InkSink | null;
  binderId: string;
}

export interface InkSink {
  image: (src: string, bookId: string, page: number) => void;
  quote: (text: string, bookId: string, page: number) => void;
  pageRef: (bookId: string, page: number) => void;
}

export const StudyBusContext = createContext<{ current: StudyBus } | null>(null);

export function useStudyBus() {
  const ctx = useContext(StudyBusContext);
  if (!ctx) throw new Error('StudyBusContext がありません');
  return ctx;
}

/** ノートに PDF からの引用（画像やテキスト）を差し込む */
export function insertFromPdf(
  bus: StudyBus,
  item: { kind: 'image'; src: string; bookId: string; page: number } | { kind: 'text'; text: string; bookId: string; page: number },
) {
  if (bus.ink) {
    if (item.kind === 'image') bus.ink.image(item.src, item.bookId, item.page);
    else bus.ink.quote(item.text, item.bookId, item.page);
    return true;
  }
  const editor = bus.editor;
  if (!editor || editor.isDestroyed) return false;
  const ref = { type: 'pageRef', attrs: { bookId: item.bookId, page: item.page, label: shortTitle(bus.bookTitle(item.bookId)) } };
  const chain = editor.chain().focus();
  if (item.kind === 'image') {
    chain.insertContent([
      { type: 'image', attrs: { src: item.src } },
      { type: 'paragraph', content: [ref, { type: 'text', text: ' ' }] },
    ]);
  } else {
    const paragraphs = item.text
      .split(/\n{2,}/)
      .map((t) => t.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean)
      .map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] }));
    chain.insertContent([
      { type: 'blockquote', content: [...paragraphs, { type: 'paragraph', content: [ref] }] },
      { type: 'paragraph' },
    ]);
  }
  chain.run();
  return true;
}

/** ノートのカーソル位置に参考書ページへのリンクを挿入 */
export function insertPageRef(bus: StudyBus, bookId: string, page: number) {
  if (bus.ink) {
    bus.ink.pageRef(bookId, page);
    return true;
  }
  const editor = bus.editor;
  if (!editor || editor.isDestroyed) return false;
  return editor.chain().focus().insertPageRef({ bookId, page, label: shortTitle(bus.bookTitle(bookId)) }).run();
}

export function shortTitle(title: string) {
  return title.length > 12 ? `${title.slice(0, 11)}…` : title;
}
