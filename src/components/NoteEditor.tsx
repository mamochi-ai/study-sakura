import { BubbleMenu, EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { db, type Note } from '../db';
import { editMathLatex, buildExtensions, insertImageFiles } from '../editor/extensions';
import { editorHooks, SlashMenu } from '../editor/slash';
import { downloadBlob } from '../lib/backup';
import { formatDate } from '../lib/format';
import { useSettings } from '../lib/settings';
import { insertPageRef, useStudyBus } from '../views/studyBus';
import { askText, toast } from './Modal';
import { notePaper, PaperPicker } from './PaperPicker';
import { createReview } from '../db';
import { MARKERS as MARKER_DEFS } from '../lib/memorize';
import { MemorizeControls } from './Memorize';

const MARKERS = MARKER_DEFS.map((m) => ({ color: m.text, name: m.label }));
const PENS = [
  { color: '', name: '黒（標準）' },
  { color: '#d32f2f', name: '赤' },
  { color: '#1565c0', name: '青' },
  { color: '#2e7d32', name: '緑' },
  { color: '#ef6c00', name: 'オレンジ' },
  { color: '#7b1fa2', name: '紫' },
];

export default function NoteEditor({ note, onSaved }: { note: Note; onSaved?: () => void }) {
  const bus = useStudyBus();
  const settings = useSettings();
  const [title, setTitle] = useState(note.title);
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const [memorize, setMemorize] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const pendingSave = useRef<(() => Promise<void>) | null>(null);

  const extensions = useMemo(() => buildExtensions(), []);

  const editor = useEditor({
    extensions,
    content: note.content ?? '',
    autofocus: note.content ? false : 'end',
    editorProps: {
      // 日本語の文章なので、英語向けの自動修正・自動大文字化は止める
      attributes: { class: 'note-content', spellcheck: 'false', lang: 'ja', autocorrect: 'off', autocapitalize: 'off' },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!files.length || !editorRef.current) return false;
        insertImageFiles(editorRef.current, files);
        return true;
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!files.length || !editorRef.current) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (pos) editorRef.current.commands.setTextSelection(pos.pos);
        insertImageFiles(editorRef.current, files);
        return true;
      },
      handleClickOn: (_view, _pos, node, _nodePos, event) => {
        if (node.type.name === 'pageRef') {
          bus.current.openPage(node.attrs.bookId, node.attrs.page);
          return true;
        }
        // Ctrl / ⌘ + クリックでリンクを開く
        const a = (event.target as HTMLElement).closest('a');
        if (a && (event.ctrlKey || event.metaKey)) {
          window.open(a.href, '_blank', 'noopener');
          return true;
        }
        return false;
      },
    },
    onUpdate: () => scheduleSave(),
  });
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  const titleRef = useRef(title);
  titleRef.current = title;

  function scheduleSave() {
    setStatus('dirty');
    clearTimeout(saveTimer.current);
    pendingSave.current = async () => {
      const ed = editorRef.current;
      pendingSave.current = null;
      setStatus('saving');
      await db.notes.update(note.id, {
        title: titleRef.current.trim() || '無題のノート',
        ...(ed && !ed.isDestroyed ? { content: ed.getJSON(), text: ed.getText({ blockSeparator: '\n' }) } : {}),
        updatedAt: Date.now(),
      });
      setStatus('saved');
      onSaved?.();
    };
    saveTimer.current = setTimeout(() => pendingSave.current?.(), 600);
  }

  // ノートを閉じる・切り替えるときは即保存
  useEffect(() => {
    const flush = () => {
      clearTimeout(saveTimer.current);
      pendingSave.current?.();
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      flush();
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // PDF 側から使えるようにエディタを登録
  useEffect(() => {
    if (!editor) return;
    bus.current.editor = editor;
    editorHooks.pickImage = () => imageInput.current?.click();
    editorHooks.insertCurrentPageRef = () => {
      const cur = bus.current.current();
      if (!cur || !insertPageRef(bus.current, cur.bookId, cur.page)) toast('参考書を開いてください');
    };
    editorHooks.addReview = async (ed) => {
      const memo = await askText({ title: '🚩 復習マーク', label: 'メモ（任意）：何が分からないか など', value: '' });
      if (memo === null) return;
      const cur = bus.current.current();
      const review = await createReview({ binderId: bus.current.binderId, noteId: note.id, bookId: cur?.bookId, page: cur?.page, memo: memo.trim() });
      ed.chain().focus().insertReviewMark(review.id).run();
      toast('復習マークを付けました（上の 🚩 一覧から確認できます）');
    };
    editorHooks.insertMath = async (ed, display) => {
      const latex = await editMathLatex('', display);
      if (latex) ed.chain().focus().insertMath(latex, display).run();
    };
    return () => {
      if (bus.current.editor === editor) bus.current.editor = null;
    };
  }, [editor, bus]);

  // 復習一覧から削除された復習マークを本文からも取り除く
  useEffect(() => {
    if (!editor) return;
    const onDeleted = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const ranges: number[] = [];
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'reviewMark' && n.attrs.reviewId === id) ranges.push(pos);
      });
      if (!ranges.length) return;
      const tr = editor.state.tr;
      for (const pos of ranges.reverse()) tr.delete(pos, pos + 1);
      editor.view.dispatch(tr);
    };
    window.addEventListener('study:review-deleted', onDeleted);
    return () => window.removeEventListener('study:review-deleted', onDeleted);
  }, [editor]);

  // 外から title が変わったとき（ノート一覧で名前変更）に追従
  useEffect(() => {
    if (status === 'saved') setTitle(note.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.title]);

  const exportHtml = () => {
    if (!editor) return;
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.8;color:#222}
img{max-width:100%}blockquote{border-left:4px solid #ddd;margin:0;padding-left:12px;color:#555}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}
mark{padding:0 2px}.page-ref{background:#eef3ff;border-radius:4px;padding:0 4px;font-size:.9em}</style></head>
<body><h1>${escapeHtml(title)}</h1>${editor.getHTML()}</body></html>`;
    downloadBlob(new Blob([html], { type: 'text/html' }), `${title || 'note'}.html`);
  };

  return (
    <div className={`note-editor${memorize ? ' memorize' : ''}${settings.hideRed ? ' hide-red' : ''}${settings.hideMarkers.map((m) => ` hide-${m}`).join('')}`} style={{ '--note-font-size': `${settings.noteFontSize}px` } as React.CSSProperties}>
      {editor && (
        <Toolbar
          editor={editor}
          onImage={() => imageInput.current?.click()}
          onExportHtml={exportHtml}
          memorize={memorize}
          paper={<PaperPicker note={note} />}
          onMemorize={() => {
            editor.setEditable(memorize);
            setMemorize(!memorize);
          }}
        />
      )}
      {memorize && <div className="memorize-banner">暗記シート中：選んだ色の文字やマーカーが隠れています。タップ（マウスを乗せる）と見えます。</div>}
      <div className="note-scroll" ref={scrollRef}>
        <div className={`note-paper paper-${notePaper(note)}`}>
          <input
            className="note-title"
            value={title}
            placeholder="ノートのタイトル"
            onChange={(e) => {
              setTitle(e.target.value);
              scheduleSave();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                editor?.commands.focus('start');
              }
            }}
          />
          <EditorContent editor={editor} />
        </div>
      </div>
      {editor && <BubbleToolbar editor={editor} />}
      <SlashMenu />
      <div className="note-status">
        <span>{editor?.storage.characterCount.characters() ?? 0} 文字</span>
        <span>{{ saved: `保存済み・${formatDate(note.updatedAt)}`, dirty: '編集中…', saving: '保存中…' }[status]}</span>
      </div>
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (editor) insertImageFiles(editor, Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </div>
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/* ---------- ツールバー ---------- */

function Toolbar({
  editor,
  onImage,
  onExportHtml,
  memorize,
  onMemorize,
  paper,
}: {
  editor: Editor;
  onImage: () => void;
  onExportHtml: () => void;
  memorize: boolean;
  onMemorize: () => void;
  paper: React.ReactNode;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p',
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      sub: e.isActive('subscript'),
      sup: e.isActive('superscript'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
      table: e.isActive('table'),
      image: e.isActive('image'),
      align: (['center', 'right'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();

  const setLink = async () => {
    const prev = editor.getAttributes('link').href ?? '';
    const url = await askText({ title: 'リンク', label: 'URL（空にするとリンクを解除）', value: prev, placeholder: 'https://' });
    if (url === null) return;
    if (!url.trim()) c().extendMarkRange('link').unsetLink().run();
    else if (editor.state.selection.empty && !prev) c().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    else c().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div
      className="note-toolbar"
      role="toolbar"
      aria-label="書式"
      // ボタンを押してもエディタの選択範囲を失わないようにする
      onMouseDown={(e) => (e.target as HTMLElement).closest('button, summary') && e.preventDefault()}
    >
      <button className="icon-btn" disabled={!s.canUndo} onClick={() => c().undo().run()} title="元に戻す (Ctrl+Z)">↶</button>
      <button className="icon-btn" disabled={!s.canRedo} onClick={() => c().redo().run()} title="やり直す (Ctrl+Shift+Z)">↷</button>
      <span className="tb-sep" />
      <select
        className="block-select"
        value={s.block}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'p') c().setParagraph().run();
          else c().setHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run();
        }}
        aria-label="段落スタイル"
      >
        <option value="p">本文</option>
        <option value="h1">見出し 1</option>
        <option value="h2">見出し 2</option>
        <option value="h3">見出し 3</option>
      </select>
      <span className="tb-sep" />
      <button className={`icon-btn b${s.bold ? ' active' : ''}`} onClick={() => c().toggleBold().run()} title="太字 (Ctrl+B)">B</button>
      <button className={`icon-btn i${s.italic ? ' active' : ''}`} onClick={() => c().toggleItalic().run()} title="斜体 (Ctrl+I)">I</button>
      <button className={`icon-btn u${s.underline ? ' active' : ''}`} onClick={() => c().toggleUnderline().run()} title="下線 (Ctrl+U)">U</button>
      <button className={`icon-btn s${s.strike ? ' active' : ''}`} onClick={() => c().toggleStrike().run()} title="取り消し線 (Ctrl+Shift+S)">S</button>
      <ColorMenu editor={editor} />
      <span className="tb-sep" />
      <button className={`icon-btn${s.bullet ? ' active' : ''}`} onClick={() => c().toggleBulletList().run()} title="箇条書き (Ctrl+Shift+8)">•≡</button>
      <button className={`icon-btn${s.ordered ? ' active' : ''}`} onClick={() => c().toggleOrderedList().run()} title="番号付きリスト (Ctrl+Shift+7)">1≡</button>
      <button className={`icon-btn${s.task ? ' active' : ''}`} onClick={() => c().toggleTaskList().run()} title="チェックリスト (Ctrl+Shift+9)">☑</button>
      <button className={`icon-btn${s.quote ? ' active' : ''}`} onClick={() => c().toggleBlockquote().run()} title="引用 (Ctrl+Shift+B)">❝</button>
      <span className="tb-sep" />
      <details className="menu">
        <summary className="icon-btn" title="挿入">＋</summary>
        <div className="menu-list">
          <button onClick={onImage}>🖼 画像</button>
          <button onClick={() => editorHooks.insertMath?.(editor, false)}>∑ 数式（文中）</button>
          <button onClick={() => editorHooks.insertMath?.(editor, true)}>∫ 数式（ブロック）</button>
          <button onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>▦ 表</button>
          <button onClick={() => c().toggleCodeBlock().run()}>{'</>'} コードブロック</button>
          <button onClick={() => c().setHorizontalRule().run()}>― 区切り線</button>
          <button onClick={setLink}>🔗 リンク</button>
          <button onClick={() => editorHooks.insertCurrentPageRef?.(editor)}>📖 表示中のページを参照</button>
        </div>
      </details>
      {paper}
      <details className="menu">
        <summary className="icon-btn" title="その他の書式">Aa</summary>
        <div className="menu-list">
          <button className={s.code ? 'active' : ''} onClick={() => c().toggleCode().run()}>{'`'} インラインコード</button>
          <button className={s.sub ? 'active' : ''} onClick={() => c().toggleSubscript().run()}>x₂ 下付き</button>
          <button className={s.sup ? 'active' : ''} onClick={() => c().toggleSuperscript().run()}>x² 上付き</button>
          <button className={s.align === 'left' ? 'active' : ''} onClick={() => c().setTextAlign('left').run()}>⇤ 左寄せ</button>
          <button className={s.align === 'center' ? 'active' : ''} onClick={() => c().setTextAlign('center').run()}>↔ 中央寄せ</button>
          <button className={s.align === 'right' ? 'active' : ''} onClick={() => c().setTextAlign('right').run()}>⇥ 右寄せ</button>
          <button onClick={() => c().unsetAllMarks().clearNodes().run()}>⌫ 書式をクリア</button>
          <button onClick={onExportHtml}>⤓ HTML で書き出し</button>
          <button onClick={() => window.print()}>🖨 印刷 / PDF 保存</button>
        </div>
      </details>
      {s.table && (
        <>
          <span className="tb-sep" />
          <details className="menu">
            <summary className="btn small">表 ▾</summary>
            <div className="menu-list">
              <button onClick={() => c().addRowAfter().run()}>行を下に追加</button>
              <button onClick={() => c().addColumnAfter().run()}>列を右に追加</button>
              <button onClick={() => c().deleteRow().run()}>行を削除</button>
              <button onClick={() => c().deleteColumn().run()}>列を削除</button>
              <button onClick={() => c().toggleHeaderRow().run()}>見出し行の切替</button>
              <button onClick={() => c().mergeOrSplit().run()}>セルの結合 / 分割</button>
              <button onClick={() => c().deleteTable().run()}>表を削除</button>
            </div>
          </details>
        </>
      )}
      <button className="icon-btn" onClick={() => editorHooks.addReview?.(editor)} title="復習マークを付ける（分からないところに 🚩）">🚩</button>
      <span className="tb-spacer" />
      <MemorizeControls active={memorize} onToggle={onMemorize} />
      {s.image && (
        <>
          <span className="tb-sep" />
          <span className="tb-label">画像</span>
          {['25%', '50%', '75%', '100%'].map((w) => (
            <button key={w} className="btn small" onClick={() => c().updateAttributes('image', { width: w }).run()}>{w}</button>
          ))}
          <button className="btn small danger ghost" onClick={() => c().deleteSelection().run()}>🗑 削除</button>
        </>
      )}
    </div>
  );
}

function ColorMenu({ editor }: { editor: Editor }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => ref.current?.removeAttribute('open');
  return (
    <details className="menu" ref={ref}>
      <summary className="icon-btn" title="マーカー・文字色">🖍</summary>
      <div className="menu-list color-menu">
        <div className="menu-caption">マーカー</div>
        <div className="swatches">
          {MARKERS.map((m) => (
            <button key={m.color} className="swatch" style={{ background: m.color }} title={m.name} onClick={() => { editor.chain().focus().toggleHighlight({ color: m.color }).run(); close(); }} />
          ))}
          <button className="swatch none" title="マーカーを消す" onClick={() => { editor.chain().focus().unsetHighlight().run(); close(); }}>✕</button>
        </div>
        <div className="menu-caption">文字色</div>
        <div className="swatches">
          {PENS.map((p) => (
            <button
              key={p.name}
              className="swatch pen"
              style={{ color: p.color || 'var(--text)' }}
              title={p.name}
              onClick={() => {
                if (p.color) editor.chain().focus().setColor(p.color).run();
                else editor.chain().focus().unsetColor().run();
                close();
              }}
            >
              A
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

/** 文字を選択したときに出る小さなツールバー（マーカーを素早く引ける） */
function BubbleToolbar({ editor }: { editor: Editor }) {
  return (
    <BubbleMenu
      editor={editor}
      tippyOptions={{ duration: 120, placement: 'top' }}
      shouldShow={({ editor: e, state }) => !state.selection.empty && !e.isActive('image') && !e.isActive('pageRef') && !e.isActive('mathInline') && !e.isActive('mathBlock')}
    >
      <div className="bubble" onMouseDown={(e) => e.preventDefault()}>
        <button className="b" onClick={() => editor.chain().focus().toggleBold().run()}>B</button>
        <button className="u" onClick={() => editor.chain().focus().toggleUnderline().run()}>U</button>
        {MARKERS.slice(0, 4).map((m) => (
          <button key={m.color} className="dot" style={{ background: m.color }} title={`${m.name}マーカー`} onClick={() => editor.chain().focus().toggleHighlight({ color: m.color }).run()} />
        ))}
        <button style={{ color: '#d32f2f', fontWeight: 700 }} title="赤字" onClick={() => editor.chain().focus().setColor('#d32f2f').run()}>A</button>
        <button title="書式をクリア" onClick={() => editor.chain().focus().unsetAllMarks().run()}>⌫</button>
      </div>
    </BubbleMenu>
  );
}
