import { useEffect, useState } from 'react';
import type { Binder, Book } from '../db';
import { renderCover } from '../lib/pdf';

const coverCache = new Map<string, string>();

export function useCover(bookId: string | undefined) {
  const [src, setSrc] = useState(() => (bookId ? coverCache.get(bookId) : undefined));
  useEffect(() => {
    if (!bookId) return setSrc(undefined);
    const cached = coverCache.get(bookId);
    if (cached) return setSrc(cached);
    let alive = true;
    renderCover(bookId)
      .then((url) => {
        coverCache.set(bookId, url);
        if (alive) setSrc(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bookId]);
  return src;
}

/** 本の高さを書名の長さ・ページ数から少しだけ変えて、本棚らしく見せる */
function spineHeight(book: Book) {
  let h = 0;
  for (const c of book.id) h = (h * 31 + c.charCodeAt(0)) % 997;
  return 168 + (h % 5) * 8;
}

export function BookSpine({ book, onClick, selected }: { book: Book; onClick: () => void; selected?: boolean }) {
  const width = Math.min(58, 34 + Math.round(Math.sqrt(book.pageCount ?? 150) * 1.2));
  return (
    <button
      className={`spine book-spine${selected ? ' selected' : ''}`}
      style={{ '--spine-color': book.color, height: spineHeight(book), width } as React.CSSProperties}
      onClick={onClick}
      title={book.title}
    >
      <span className="spine-band" />
      <span className="spine-title">{book.title}</span>
      <span className="spine-band bottom" />
    </button>
  );
}

export function BinderSpine({ binder, onClick, onEdit }: { binder: Binder; onClick: () => void; onEdit: () => void }) {
  return (
    <div className="binder-spine-wrap">
      <button
        className="spine binder-spine"
        style={{ '--spine-color': binder.color } as React.CSSProperties}
        onClick={onClick}
        title={`${binder.title} を開く`}
      >
        <span className="binder-ring" />
        <span className="binder-label">
          <span className="spine-title">{binder.title}</span>
        </span>
        <span className="binder-ring" />
      </button>
      <button className="spine-edit" onClick={onEdit} title="バインダーを編集" aria-label={`${binder.title} を編集`}>
        ✎
      </button>
    </div>
  );
}

export function BookCover({ book, size = 56 }: { book: Book; size?: number }) {
  const src = useCover(book.id);
  return src ? (
    <img className="book-cover" src={src} alt="" style={{ width: size }} />
  ) : (
    <div className="book-cover placeholder" style={{ width: size, height: size * 1.4, background: book.color }} />
  );
}
