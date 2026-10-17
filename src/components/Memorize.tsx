import { MARKERS } from '../lib/memorize';
import { updateSettings, useSettings, type MarkerName } from '../lib/settings';

/** 暗記シートのオン / オフと、隠すものの選択 */
export function MemorizeControls({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const s = useSettings();
  const toggleMarker = (m: MarkerName) =>
    updateSettings({ hideMarkers: s.hideMarkers.includes(m) ? s.hideMarkers.filter((x) => x !== m) : [...s.hideMarkers, m] });
  return (
    <span className="memorize-controls">
      <button className={`btn small memorize-btn${active ? ' active' : ''}`} onClick={onToggle} title="赤ペン・マーカーを隠して暗記チェック">
        {active ? <>🟥<span className="tb-text"> 暗記シートを</span>外す</> : <>🟥<span className="tb-text"> 暗記シート</span></>}
      </button>
      <details className="menu">
        <summary className="icon-btn tiny" title="隠すものを選ぶ" aria-label="暗記シートで隠すもの">▾</summary>
        <div className="menu-list right hide-menu">
          <div className="menu-caption">暗記シートで隠すもの</div>
          <label className="check">
            <input type="checkbox" checked={s.hideRed} onChange={(e) => updateSettings({ hideRed: e.target.checked })} />
            <span className="hide-sample red">赤</span> 赤・オレンジの文字（ペン）
          </label>
          {MARKERS.map((m) => (
            <label key={m.name} className="check">
              <input type="checkbox" checked={s.hideMarkers.includes(m.name)} onChange={() => toggleMarker(m.name)} />
              <span className="hide-sample" style={{ background: m.text }}>　</span> {m.label}マーカー
            </label>
          ))}
        </div>
      </details>
    </span>
  );
}
