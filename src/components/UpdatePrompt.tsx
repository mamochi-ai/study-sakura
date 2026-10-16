import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect } from 'react';
import { toast } from './Modal';

/** 新しいバージョンが届いたら、ユーザーが選んだときだけ更新する */
export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // 開きっぱなしでも 1 時間ごとに更新を確認
      if (reg) setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    },
  });

  useEffect(() => {
    if (!offlineReady) return;
    toast('オフラインでも使えるようになりました');
    setOfflineReady(false);
  }, [offlineReady, setOfflineReady]);

  if (!needRefresh) return null;
  return (
    <div className="update-banner" role="status">
      <span>新しいバージョンがあります</span>
      <button className="btn small" onClick={() => setNeedRefresh(false)}>あとで</button>
      <button
        className="btn small primary"
        onClick={() => {
          // ノートは閉じる直前に保存されるが、念のため少し待ってから更新する
          window.dispatchEvent(new Event('pagehide'));
          setTimeout(() => updateServiceWorker(true), 400);
        }}
      >
        更新する
      </button>
    </div>
  );
}
