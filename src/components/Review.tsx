import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db, REVIEW_STATUS, type Review, type ReviewStatus } from '../db';
import { formatDate } from '../lib/format';
import { confirmDialog, Modal, toast } from './Modal';

/* ---------- 復習マークの状態をノートの表示側（エディタの部品）に配るストア ---------- */

let statusMap = new Map<string, ReviewStatus>();
const subs = new Set<() => void>();
export const reviewStore = {
  get: (id: string) => statusMap.get(id),
  set(list: Review[]) {
    statusMap = new Map(list.map((r) => [r.id, r.status]));
    subs.forEach((s) => s());
  },
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => void subs.delete(fn);
  },
};

/** 復習マークの詳細を開く（ノートのどこからでも呼べる） */
export const openReview = (id: string) => window.dispatchEvent(new CustomEvent('study:open-review', { detail: id }));
/** 復習マークの場所へ移動する */
export const focusReview = (id: string) => window.dispatchEvent(new CustomEvent('study:focus-review', { detail: id }));

/** ノートの中の復習マーク（テキストの部品・手書きの旗）を探して見える位置へ */
export function scrollToReviewElement(id: string) {
  let tries = 0;
  const find = () => {
    const el = document.querySelector<HTMLElement>(`[data-review-id="${id}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    } else if (tries++ < 20) setTimeout(find, 100);
  };
  find();
}

/** テキストノートの本文（JSON）から復習マークを取り除く */
function stripReview(content: unknown, id: string): unknown {
  if (Array.isArray(content)) return content.filter((n) => !(n?.type === 'reviewMark' && n.attrs?.reviewId === id)).map((n) => stripReview(n, id));
  if (content && typeof content === 'object') {
    const c = content as { content?: unknown };
    return c.content ? { ...c, content: stripReview(c.content, id) } : c;
  }
  return content;
}

export async function deleteReview(review: Review) {
  await db.transaction('rw', [db.reviews, db.inkItems, db.notes], async () => {
    await db.reviews.delete(review.id);
    await db.inkItems.where('noteId').equals(review.noteId).filter((i) => i.reviewId === review.id).delete();
    const note = await db.notes.get(review.noteId);
    if (note?.content) await db.notes.update(note.id, { content: stripReview(note.content, review.id) as typeof note.content });
  });
  // 開いているテキストノートからも消す
  window.dispatchEvent(new CustomEvent('study:review-deleted', { detail: review.id }));
}

export function StatusPicker({ value, onChange }: { value: ReviewStatus; onChange: (s: ReviewStatus) => void }) {
  return (
    <div className="status-picker" role="radiogroup" aria-label="復習の状態">
      {(Object.keys(REVIEW_STATUS) as ReviewStatus[]).map((s) => (
        <button
          key={s}
          role="radio"
          aria-checked={value === s}
          className={value === s ? 'active' : ''}
          style={{ '--status-color': REVIEW_STATUS[s].color } as React.CSSProperties}
          onClick={() => onChange(s)}
        >
          {REVIEW_STATUS[s].label}
        </button>
      ))}
    </div>
  );
}

/** 復習マークの詳細（状態・メモ・削除） */
export function ReviewDialog({ id, onClose, onJump }: { id: string; onClose: () => void; onJump: (r: Review) => void }) {
  const review = useLiveQuery(() => db.reviews.get(id), [id]);
  const note = useLiveQuery(() => (review ? db.notes.get(review.noteId) : undefined), [review?.noteId]);
  const [memo, setMemo] = useState<string | null>(null);
  useEffect(() => {
    if (review && memo === null) setMemo(review.memo);
  }, [review, memo]);
  if (!review) return null;
  const save = (patch: Partial<Review>) => db.reviews.update(id, { ...patch, updatedAt: Date.now() });
  return (
    <Modal
      title="🚩 復習マーク"
      onClose={() => {
        if (memo !== null && memo !== review.memo) save({ memo });
        onClose();
      }}
      footer={
        <>
          <button
            className="btn danger ghost"
            style={{ marginRight: 'auto' }}
            onClick={async () => {
              if (!(await confirmDialog({ title: '復習マークを削除', message: 'この復習マークを削除しますか？', danger: true, okLabel: '削除する' }))) return;
              await deleteReview(review);
              toast('復習マークを削除しました');
              onClose();
            }}
          >
            削除
          </button>
          <button
            className="btn"
            onClick={() => {
              if (memo !== null && memo !== review.memo) save({ memo });
              onJump(review);
              onClose();
            }}
          >
            この場所へ移動
          </button>
          <button
            className="btn primary"
            onClick={() => {
              if (memo !== null && memo !== review.memo) save({ memo });
              onClose();
            }}
          >
            閉じる
          </button>
        </>
      }
    >
      <div className="field">
        <span>状態</span>
        <StatusPicker value={review.status} onChange={(status) => save({ status })} />
      </div>
      <label className="field">
        <span>メモ（何が分からないか など）</span>
        <textarea rows={3} value={memo ?? ''} onChange={(e) => setMemo(e.target.value)} placeholder="例：RAG とファインチューニングの違い" />
      </label>
      <p className="muted small">
        📝 {note?.title ?? '（削除されたノート）'}
        {review.page ? `　📖 p.${review.page}` : ''}　・　{formatDate(review.createdAt)}
      </p>
    </Modal>
  );
}

type Filter = 'open' | ReviewStatus | 'all';

/** バインダーの復習一覧 */
export function ReviewPanel({ binderId, onClose, onJump }: { binderId: string; onClose: () => void; onJump: (r: Review) => void }) {
  const [filter, setFilter] = useState<Filter>('open');
  const reviews = useLiveQuery(() => db.reviews.where('binderId').equals(binderId).toArray(), [binderId]) ?? [];
  const notes = useLiveQuery(() => db.notes.where('binderId').equals(binderId).toArray(), [binderId]) ?? [];
  const books = useLiveQuery(() => db.books.toArray(), []) ?? [];
  const order: Record<ReviewStatus, number> = { todo: 0, doing: 1, done: 2 };
  const list = reviews
    .filter((r) => (filter === 'all' ? true : filter === 'open' ? r.status !== 'done' : r.status === filter))
    .sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt);
  const count = (f: Filter) => reviews.filter((r) => (f === 'all' ? true : f === 'open' ? r.status !== 'done' : r.status === f)).length;
  const tabs: { key: Filter; label: string }[] = [
    { key: 'open', label: '要復習' },
    { key: 'todo', label: '未理解' },
    { key: 'doing', label: '復習中' },
    { key: 'done', label: '理解済み' },
    { key: 'all', label: 'すべて' },
  ];
  return (
    <>
      <div className="review-backdrop" onPointerDown={onClose} />
      <aside className="review-panel" aria-label="復習一覧">
        <div className="review-head">
          <h2>🚩 復習一覧</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">✕</button>
        </div>
        <div className="review-tabs">
          {tabs.map((t) => (
            <button key={t.key} className={filter === t.key ? 'active' : ''} onClick={() => setFilter(t.key)}>
              {t.label}
              <span className="count">{count(t.key)}</span>
            </button>
          ))}
        </div>
        <ul className="review-list">
          {list.map((r) => {
            const note = notes.find((n) => n.id === r.noteId);
            const book = books.find((b) => b.id === r.bookId);
            return (
              <li key={r.id} className="review-item" style={{ '--status-color': REVIEW_STATUS[r.status].color } as React.CSSProperties}>
                <button className="review-main" onClick={() => onJump(r)}>
                  <span className="review-memo">{r.memo || '（メモなし）'}</span>
                  <span className="review-meta">
                    {note?.kind === 'ink' ? '✏️' : '📝'} {note?.title ?? '—'}
                    {r.page ? `　📖 ${book ? `${book.title.slice(0, 10)} ` : ''}p.${r.page}` : ''}
                  </span>
                </button>
                <StatusPicker value={r.status} onChange={(status) => db.reviews.update(r.id, { status, updatedAt: Date.now() })} />
              </li>
            );
          })}
          {list.length === 0 && (
            <li className="muted small pad">
              {reviews.length === 0
                ? 'まだ復習マークはありません。ノートのツールバーの 🚩 で、分からないところに印を付けられます。'
                : 'この条件の復習マークはありません。'}
            </li>
          )}
        </ul>
      </aside>
    </>
  );
}
