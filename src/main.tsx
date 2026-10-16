import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import App from './App';

// ブラウザにデータを消されにくくする
navigator.storage?.persist?.().catch(() => {});

// iPad：画面全体がピンチで拡大されないようにする（参考書は独自に拡大縮小できる）
document.addEventListener('gesturestart', (e) => e.preventDefault());

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
