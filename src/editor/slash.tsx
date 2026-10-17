import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/** エディタの外（PDF 側など）の機能をスラッシュメニューから呼ぶためのフック */
export const editorHooks: {
  insertCurrentPageRef?: (editor: Editor) => void;
  pickImage?: (editor: Editor) => void;
  insertMath?: (editor: Editor, display: boolean) => void;
  addReview?: (editor: Editor) => void;
} = {};

export interface SlashItem {
  title: string;
  hint: string;
  icon: string;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  { title: '見出し 1', hint: '大きな見出し', icon: 'H1', keywords: 'h1 heading midashi 見出し', run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run() },
  { title: '見出し 2', hint: '中くらいの見出し', icon: 'H2', keywords: 'h2 heading midashi 見出し', run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run() },
  { title: '見出し 3', hint: '小さな見出し', icon: 'H3', keywords: 'h3 heading midashi 見出し', run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run() },
  { title: '箇条書き', hint: '・リスト', icon: '•', keywords: 'bullet list ul kajougaki 箇条書き リスト', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: '番号付きリスト', hint: '1. 2. 3.', icon: '1.', keywords: 'ordered number list ol bangou 番号', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { title: 'チェックリスト', hint: 'やることリスト', icon: '☑', keywords: 'todo task check checklist チェック', run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { title: '引用', hint: '参考書の文章など', icon: '❝', keywords: 'quote blockquote inyou 引用', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: 'コード', hint: 'プログラムなど', icon: '</>', keywords: 'code codeblock コード', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { title: '表', hint: '3×3 の表', icon: '▦', keywords: 'table hyou 表', run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { title: '区切り線', hint: '水平線', icon: '―', keywords: 'hr divider line kugiri 区切り', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  { title: '数式', hint: '文中の数式（LaTeX）', icon: '∑', keywords: 'math latex suushiki sum 数式 katex', run: (e, r) => { e.chain().focus().deleteRange(r).run(); editorHooks.insertMath?.(e, false); } },
  { title: '数式ブロック', hint: '中央寄せの数式', icon: '∫', keywords: 'math block latex suushiki 数式', run: (e, r) => { e.chain().focus().deleteRange(r).run(); editorHooks.insertMath?.(e, true); } },
  { title: '画像', hint: 'ファイルから挿入', icon: '🖼', keywords: 'image picture gazou 画像', run: (e, r) => { e.chain().focus().deleteRange(r).run(); editorHooks.pickImage?.(e); } },
  { title: '復習マーク', hint: '分からないところに 🚩 を付ける', icon: '🚩', keywords: 'review flag fukushuu 復習 マーク 旗', run: (e, r) => { e.chain().focus().deleteRange(r).run(); editorHooks.addReview?.(e); } },
  { title: '今のページを参照', hint: '参考書の表示中ページへのリンク', icon: '📖', keywords: 'page ref pdf sansyou 参照 ページ', run: (e, r) => { e.chain().focus().deleteRange(r).run(); editorHooks.insertCurrentPageRef?.(e); } },
];

/* ---------- メニュー表示用の小さなストア ---------- */

interface MenuState {
  items: SlashItem[];
  index: number;
  rect: DOMRect | null;
  command: ((item: SlashItem) => void) | null;
}
let menu: MenuState | null = null;
const subs = new Set<() => void>();
const set = (m: MenuState | null) => {
  menu = m;
  subs.forEach((s) => s());
};

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    // 日本語入力中の全角「／」でも開けるようにする
    return ['/', '／'].map((char, i) =>
      Suggestion<SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey(`slashCommand${i}`),
        char,
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }) => {
          const q = query.toLowerCase();
          return SLASH_ITEMS.filter((it) => !q || it.title.toLowerCase().includes(q) || it.keywords.includes(q));
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          const update = (p: SuggestionProps<SlashItem>) =>
            set({ items: p.items, index: Math.min(menu?.index ?? 0, Math.max(0, p.items.length - 1)), rect: p.clientRect?.() ?? null, command: (it) => p.command(it) });
          return {
            onStart: (p) => {
              menu = null;
              update(p);
            },
            onUpdate: update,
            onExit: () => set(null),
            onKeyDown: ({ event }) => {
              if (!menu || menu.items.length === 0) return false;
              if (event.key === 'ArrowDown') {
                set({ ...menu, index: (menu.index + 1) % menu.items.length });
                return true;
              }
              if (event.key === 'ArrowUp') {
                set({ ...menu, index: (menu.index - 1 + menu.items.length) % menu.items.length });
                return true;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                menu.command?.(menu.items[menu.index]);
                return true;
              }
              if (event.key === 'Escape') {
                set(null);
                return true;
              }
              return false;
            },
          };
        },
      }),
    );
  },
});

export function SlashMenu() {
  const m = useSyncExternalStore(
    (l) => {
      subs.add(l);
      return () => subs.delete(l);
    },
    () => menu,
  );
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>('.active');
    if (!list || !item) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  }, [m?.index]);
  if (!m || !m.rect || m.items.length === 0) return null;
  const below = m.rect.bottom + 320 < window.innerHeight;
  return (
    <div
      ref={listRef}
      className="slash-menu"
      style={{ left: Math.min(m.rect.left, window.innerWidth - 270), ...(below ? { top: m.rect.bottom + 6 } : { bottom: window.innerHeight - m.rect.top + 6 }) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {m.items.map((it, i) => (
        <button key={it.title} className={i === m.index ? 'active' : ''} onClick={() => m.command?.(it)} onMouseEnter={() => set({ ...m, index: i })}>
          <span className="slash-icon">{it.icon}</span>
          <span className="slash-text">
            <span>{it.title}</span>
            <small>{it.hint}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
