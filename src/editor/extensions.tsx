import { mergeAttributes, Node, type Editor, type Range } from '@tiptap/core';
import CharacterCount from '@tiptap/extension-character-count';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import TextAlign from '@tiptap/extension-text-align';
import TextStyle from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import katex from 'katex';
import { askText } from '../components/Modal';
import { openReview, reviewStore } from '../components/Review';
import { REVIEW_STATUS } from '../db';
import { SlashCommand } from './slash';

/* ---------- 参考書ページへのリンク（クリックで PDF がそのページへ） ---------- */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageRef: { insertPageRef: (attrs: { bookId: string; page: number; label?: string }) => ReturnType };
    math: { insertMath: (latex: string, display?: boolean) => ReturnType };
    reviewMark: { insertReviewMark: (reviewId: string) => ReturnType };
  }
}

export const PageRef = Node.create({
  name: 'pageRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      bookId: { default: null, parseHTML: (el) => el.getAttribute('data-book-id') },
      page: { default: 1, parseHTML: (el) => Number(el.getAttribute('data-page')) || 1 },
      label: { default: '', parseHTML: (el) => el.getAttribute('data-label') ?? '' },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-page-ref]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { bookId, page, label } = node.attrs;
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-page-ref': '',
        'data-book-id': bookId,
        'data-page': page,
        'data-label': label,
        class: 'page-ref',
        title: `${label ? `${label} ` : ''}p.${page} を開く`,
      }),
      `📖 ${label ? `${label} ` : ''}p.${page}`,
    ];
  },
  renderText({ node }) {
    return `[${node.attrs.label ? `${node.attrs.label} ` : ''}p.${node.attrs.page}]`;
  },
  addCommands() {
    return {
      insertPageRef:
        (attrs) =>
        ({ chain }) =>
          chain().insertContent([{ type: this.name, attrs }, { type: 'text', text: ' ' }]).run(),
    };
  },
});

/* ---------- 復習マーク（🚩。色は状態に合わせて変わる） ---------- */

export const ReviewMark = Node.create({
  name: 'reviewMark',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { reviewId: { default: null, parseHTML: (el) => el.getAttribute('data-review-id') } };
  },
  parseHTML() {
    return [{ tag: 'span[data-review-id]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-review-id': node.attrs.reviewId, class: 'review-mark' }), '🚩'];
  },
  renderText: () => '🚩',
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span');
      dom.className = 'review-mark';
      dom.contentEditable = 'false';
      dom.dataset.reviewId = node.attrs.reviewId;
      dom.textContent = '🚩';
      const paint = () => {
        const st = reviewStore.get(node.attrs.reviewId);
        dom.style.setProperty('--status-color', st ? REVIEW_STATUS[st].color : '#999');
        dom.title = st ? `復習マーク：${REVIEW_STATUS[st].label}（タップで詳細）` : '復習マーク';
      };
      paint();
      const unsub = reviewStore.subscribe(paint);
      dom.addEventListener('click', () => openReview(node.attrs.reviewId));
      return { dom, destroy: unsub };
    };
  },
  addCommands() {
    return {
      insertReviewMark:
        (reviewId) =>
        ({ chain }) =>
          chain().insertContent([{ type: this.name, attrs: { reviewId } }, { type: 'text', text: ' ' }]).run(),
    };
  },
});

/* ---------- 数式（KaTeX） ---------- */

export function renderMath(latex: string, el: HTMLElement, display: boolean) {
  try {
    katex.render(latex || '\\square', el, { displayMode: display, throwOnError: false });
  } catch {
    el.textContent = latex;
  }
}

export async function editMathLatex(initial: string, display: boolean) {
  return askText({
    title: display ? '数式（ブロック）' : '数式',
    label: 'LaTeX で入力（Ctrl+Enter で確定）',
    value: initial,
    placeholder: '例：\\frac{a}{b} + \\sqrt{x^2+1}',
    multiline: true,
    preview: (v) => <MathPreview latex={v} display={display} />,
  });
}

function MathPreview({ latex, display }: { latex: string; display: boolean }) {
  return <span ref={(el) => el && renderMath(latex, el, display)} />;
}

function createMathNode(name: string, display: boolean) {
  return Node.create({
    name,
    group: display ? 'block' : 'inline',
    inline: !display,
    atom: true,
    selectable: true,
    addAttributes() {
      return { latex: { default: '', parseHTML: (el) => el.getAttribute('data-latex') ?? '' } };
    },
    parseHTML() {
      return [{ tag: `${display ? 'div' : 'span'}[data-math-${display ? 'block' : 'inline'}]` }];
    },
    renderHTML({ node, HTMLAttributes }) {
      return [display ? 'div' : 'span', mergeAttributes(HTMLAttributes, { [`data-math-${display ? 'block' : 'inline'}`]: '', 'data-latex': node.attrs.latex })];
    },
    renderText({ node }) {
      return display ? `$$${node.attrs.latex}$$` : `$${node.attrs.latex}$`;
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement(display ? 'div' : 'span');
        dom.className = display ? 'math-node math-block' : 'math-node math-inline';
        dom.contentEditable = 'false';
        let current = node;
        renderMath(node.attrs.latex, dom, display);
        dom.addEventListener('dblclick', async () => {
          if (!editor.isEditable) return;
          const latex = await editMathLatex(current.attrs.latex, display);
          if (latex === null || typeof getPos !== 'function') return;
          editor.chain().focus().command(({ tr }) => {
            tr.setNodeMarkup(getPos(), undefined, { latex });
            return true;
          }).run();
        });
        return {
          dom,
          update(updated) {
            if (updated.type !== current.type) return false;
            current = updated;
            renderMath(updated.attrs.latex, dom, display);
            return true;
          },
        };
      };
    },
  });
}

const MathInline = createMathNode('mathInline', false).extend({
  addCommands() {
    return {
      insertMath:
        (latex, display = false) =>
        ({ chain }) =>
          chain().insertContent({ type: display ? 'mathBlock' : 'mathInline', attrs: { latex } }).run(),
    };
  },
});
const MathBlock = createMathNode('mathBlock', true);

/* ---------- 画像（幅を変えられる） ---------- */

const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-width'),
        renderHTML: (attrs) => (attrs.width ? { 'data-width': attrs.width, style: `width:${attrs.width}` } : {}),
      },
    };
  },
}).configure({ allowBase64: true, inline: false });

export function buildExtensions() {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    Underline,
    Highlight.configure({ multicolor: true }),
    TextStyle,
    Color,
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    ResizableImage,
    Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === 'heading' ? '見出し' : '書き始めましょう…「/」でメニュー、PDF の範囲を ✂ で切り取って貼り付けもできます'),
    }),
    CharacterCount,
    PageRef,
    ReviewMark,
    MathInline,
    MathBlock,
    SlashCommand,
  ];
}

/* ---------- 画像ファイルの読み込み ---------- */

export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** 大きすぎる画像はノートが重くならないように縮小する */
export async function shrinkImage(dataUrl: string, maxWidth = 1600): Promise<string> {
  const img = new window.Image();
  img.src = dataUrl;
  await img.decode();
  if (img.naturalWidth <= maxWidth) return dataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = maxWidth;
  canvas.height = Math.round((img.naturalHeight * maxWidth) / img.naturalWidth);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.88);
}

export async function insertImageFiles(editor: Editor, files: File[], range?: Range) {
  for (const f of files.filter((x) => x.type.startsWith('image/'))) {
    const src = await shrinkImage(await readImageFile(f));
    const chain = editor.chain().focus();
    (range ? chain.deleteRange(range) : chain).setImage({ src }).run();
  }
}
