import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import App from './App';
import { getSettings } from './lib/settings';

// ブラウザにデータを消されにくくする
navigator.storage?.persist?.().catch(() => {});

// iPad：画面全体がピンチで拡大されないようにする（参考書は独自に拡大縮小できる）
// 設定で「画面全体の拡大」を許可したときは止めない
document.addEventListener('gesturestart', (e) => {
  if (!getSettings().allowPageZoom) e.preventDefault();
});

// 開いているメニュー（details.menu）は、外側をタップしたら閉じる
document.addEventListener('pointerdown', (e) => {
  document.querySelectorAll<HTMLDetailsElement>('details.menu[open]').forEach((d) => {
    if (!d.contains(e.target as Node)) d.removeAttribute('open');
  });
});
// メニューの項目を選んだら閉じる
document.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest('.menu-list > button');
  item?.closest('details.menu')?.removeAttribute('open');
});

// 画面全体がずれて上が隠れることがあるので、文字入力中以外は常に元の位置に戻す
// （キーボードが出ているときは iPad に任せる）
const resetPageScroll = () => {
  if (window.scrollX === 0 && window.scrollY === 0) return;
  // 拡大している間は、拡大した位置を動かさない
  if (getSettings().allowPageZoom && (window.visualViewport?.scale ?? 1) > 1.01) return;
  const a = document.activeElement as HTMLElement | null;
  if (a && (a.isContentEditable || a.matches('input, textarea, select'))) return;
  window.scrollTo(0, 0);
};
window.addEventListener('scroll', resetPageScroll, { passive: true });
document.addEventListener('focusout', () => setTimeout(resetPageScroll, 300));
window.visualViewport?.addEventListener('resize', () => setTimeout(resetPageScroll, 300));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
