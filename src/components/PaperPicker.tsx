import { db, type Note, type Paper } from '../db';
import { getSettings } from '../lib/settings';

export const PAPERS: { value: Paper; label: string; icon: string }[] = [
  { value: 'plain', label: '無地', icon: '□' },
  { value: 'lined', label: '横罫線', icon: '☰' },
  { value: 'grid', label: '方眼', icon: '▦' },
  { value: 'dots', label: 'ドット', icon: '⁘' },
];

export const notePaper = (note: Note): Paper => note.paper ?? getSettings().defaultPaper;

/** ノートの用紙（罫線）を選ぶメニュー */
export function PaperPicker({ note }: { note: Note }) {
  const current = notePaper(note);
  return (
    <details className="menu">
      <summary className="icon-btn" title="用紙（罫線）">{PAPERS.find((p) => p.value === current)?.icon ?? '☰'}</summary>
      <div className="menu-list">
        <div className="menu-caption">用紙</div>
        {PAPERS.map((p) => (
          <button key={p.value} className={p.value === current ? 'active' : ''} onClick={() => db.notes.update(note.id, { paper: p.value })}>
            {p.icon} {p.label}
          </button>
        ))}
      </div>
    </details>
  );
}
