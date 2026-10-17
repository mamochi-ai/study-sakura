import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { BinderDialog, BookDialog, pickAndAddBooks, SettingsDialog } from '../components/Dialogs';
import { toast } from '../components/Modal';
import { BinderSpine, BookCover, BookSpine } from '../components/Shelf';
import { db, today, type Binder } from '../db';
import { exportBackup, importBackup } from '../lib/backup';
import { formatDuration } from '../lib/format';

export default function DeskView({ onOpenBinder }: { onOpenBinder: (id: string) => void }) {
  const books = useLiveQuery(() => db.books.orderBy('createdAt').toArray(), []);
  const binders = useLiveQuery(() => db.binders.orderBy('createdAt').toArray(), []);
  const [bookDialog, setBookDialog] = useState<string | null>(null);
  const [binderDialog, setBinderDialog] = useState<{ binder?: Binder; bookIds?: string[] } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const recent = (binders ?? [])
    .filter((b) => b.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
    .slice(0, 3);
  const openBook = books?.find((b) => b.id === bookDialog);

  return (
    <div
      className={`desk-view${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        pickAndAddBooks(e.dataTransfer.files);
      }}
    >
      <header className="desk-header">
        <h1 className="logo">
          <span className="logo-mark">🌸</span> My Study
        </h1>
        <div className="desk-actions">
          <button className="btn" onClick={() => fileRef.current?.click()}>📕 参考書を追加</button>
          <button className="btn primary" onClick={() => setBinderDialog({})}>＋ 新しいバインダー</button>
          <details className="menu">
            <summary className="btn icon" aria-label="メニュー">⋯</summary>
            <div className="menu-list">
              <button onClick={() => exportBackup().then(() => toast('バックアップを書き出しました'))}>💾 バックアップを書き出す</button>
              <button onClick={() => importRef.current?.click()}>📂 バックアップから復元</button>
              <button onClick={() => setSettingsOpen(true)}>⚙ 設定</button>
            </div>
          </details>
        </div>
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => pickAndAddBooks(e.target.files).then(() => (e.target.value = ''))} />
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              const r = await importBackup(f);
              toast(`復元しました（参考書 ${r.books}・バインダー ${r.binders}・ノート ${r.notes}）`);
            } catch (err) {
              toast(`復元できませんでした：${(err as Error).message}`);
            }
          }}
        />
      </header>

      <section className="bookshelf" aria-label="本棚">
        <div className="shelf-row">
          <div className="shelf-label">参考書</div>
          <div className="shelf-items">
            {books?.map((b) => (
              <BookSpine key={b.id} book={b} onClick={() => setBookDialog(b.id)} />
            ))}
            {books && books.length === 0 && (
              <button className="shelf-empty" onClick={() => fileRef.current?.click()}>
                タップして参考書（PDF）を追加<br />
                <small>パソコンではドラッグ＆ドロップでも追加できます</small>
              </button>
            )}
          </div>
          <div className="shelf-board" />
        </div>
        <div className="shelf-row">
          <div className="shelf-label">バインダー</div>
          <div className="shelf-items">
            {binders?.map((b) => (
              <BinderSpine key={b.id} binder={b} onClick={() => onOpenBinder(b.id)} onEdit={() => setBinderDialog({ binder: b })} />
            ))}
            {binders && binders.length === 0 && (
              <button className="shelf-empty" onClick={() => setBinderDialog({})}>
                バインダー ＝ 参考書とノートのセット<br />タップして科目ごとに作りましょう
              </button>
            )}
          </div>
          <div className="shelf-board" />
        </div>
      </section>

      <section className="desk" aria-label="勉強机">
        <div className="desk-surface">
          <div className="desk-recent">
            <h2>続きから勉強する</h2>
            {recent.length === 0 ? (
              <p className="desk-hint">本棚のバインダーをクリックすると、参考書とノートが机に広がります。</p>
            ) : (
              <div className="recent-list">
                {recent.map((b) => (
                  <RecentCard key={b.id} binder={b} onOpen={() => onOpenBinder(b.id)} />
                ))}
              </div>
            )}
          </div>
          <StudyRecord />
        </div>
      </section>

      {dragging && <div className="drop-overlay">PDF を離すと本棚に追加します</div>}
      {openBook && (
        <BookDialog
          book={openBook}
          onClose={() => setBookDialog(null)}
          onCreateBinder={(id) => {
            setBookDialog(null);
            setBinderDialog({ bookIds: [id] });
          }}
        />
      )}
      {binderDialog && (
        <BinderDialog
          binder={binderDialog.binder}
          initialBookIds={binderDialog.bookIds}
          onClose={() => setBinderDialog(null)}
          onCreated={(b) => onOpenBinder(b.id)}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function RecentCard({ binder, onOpen }: { binder: Binder; onOpen: () => void }) {
  const book = useLiveQuery(() => (binder.activeBookId ? db.books.get(binder.activeBookId) : undefined), [binder.activeBookId]);
  const note = useLiveQuery(() => (binder.lastNoteId ? db.notes.get(binder.lastNoteId) : undefined), [binder.lastNoteId]);
  const pos = binder.activeBookId ? binder.positions[binder.activeBookId] : undefined;
  return (
    <button className="recent-card" onClick={onOpen} style={{ '--binder-color': binder.color } as React.CSSProperties}>
      <div className="recent-book">{book ? <BookCover book={book} size={54} /> : <div className="book-cover placeholder" style={{ width: 54, height: 76 }} />}</div>
      <div className="recent-paper">
        <div className="recent-title">{binder.title}</div>
        <div className="recent-meta">
          {note && <span>📝 {note.title}</span>}
          {book && <span>📖 {book.title}{pos ? ` p.${pos.page}` : ''}</span>}
        </div>
      </div>
    </button>
  );
}

function StudyRecord() {
  const sessions = useLiveQuery(() => db.sessions.toArray(), []) ?? [];
  const binders = useLiveQuery(() => db.binders.toArray(), []) ?? [];
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const key = today(d);
    return { key, label: '日月火水木金土'[d.getDay()], seconds: sessions.filter((s) => s.date === key).reduce((a, s) => a + s.seconds, 0) };
  });
  const max = Math.max(3600, ...days.map((d) => d.seconds));
  const week = days.reduce((a, d) => a + d.seconds, 0);
  const todaySec = days[6].seconds;
  const streak = (() => {
    const set = new Set(sessions.filter((s) => s.seconds >= 60).map((s) => s.date));
    let n = 0;
    const d = new Date();
    if (!set.has(today(d))) d.setDate(d.getDate() - 1);
    while (set.has(today(d))) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  })();
  const byBinder = binders
    .map((b) => ({ b, s: sessions.filter((x) => x.binderId === b.id && days.some((d) => d.key === x.date)).reduce((a, x) => a + x.seconds, 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4);

  return (
    <div className="study-record">
      <h2>学習記録</h2>
      <div className="record-stats">
        <div><span className="stat-num">{formatDuration(todaySec)}</span><span className="stat-label">今日</span></div>
        <div><span className="stat-num">{formatDuration(week)}</span><span className="stat-label">7日間</span></div>
        <div><span className="stat-num">{streak}日</span><span className="stat-label">連続</span></div>
      </div>
      <div className="record-chart" aria-label="直近7日の学習時間">
        {days.map((d) => (
          <div key={d.key} className="bar-col" title={`${d.key} ${formatDuration(d.seconds)}`}>
            <div className="bar" style={{ height: `${(d.seconds / max) * 100}%` }} />
            <span>{d.label}</span>
          </div>
        ))}
      </div>
      {byBinder.length > 0 && (
        <ul className="record-binders">
          {byBinder.map(({ b, s }) => (
            <li key={b.id}><span className="dot" style={{ background: b.color }} />{b.title}<span className="muted">{formatDuration(s)}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}
