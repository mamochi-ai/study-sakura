import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { addStudyTime, db, today } from '../db';
import { formatClock, formatDuration } from '../lib/format';
import { useSettings } from '../lib/settings';
import { toast } from './Modal';

const IDLE_LIMIT = 5 * 60 * 1000;

/** バインダーを開いている間の学習時間を自動で記録する（5分操作がなければ一時停止） */
export function useStudyTracker(binderId: string) {
  const [unsaved, setUnsaved] = useState(0);
  const lastActive = useRef(Date.now());
  const pending = useRef(0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    const mark = () => (lastActive.current = Date.now());
    const events = ['pointerdown', 'keydown', 'wheel', 'pointermove'] as const;
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    const flush = () => {
      if (pending.current <= 0) return;
      const sec = pending.current;
      pending.current = 0;
      setUnsaved(0);
      addStudyTime(binderId, sec, startedAt.current);
      startedAt.current = Date.now();
    };
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - lastActive.current < IDLE_LIMIT) {
        pending.current += 1;
        setUnsaved(pending.current);
        if (pending.current >= 30) flush();
      }
    }, 1000);
    window.addEventListener('pagehide', flush);
    return () => {
      events.forEach((e) => window.removeEventListener(e, mark));
      window.removeEventListener('pagehide', flush);
      clearInterval(tick);
      flush();
    };
  }, [binderId]);

  const saved = useLiveQuery(() => db.sessions.get(`${binderId}:${today()}`), [binderId]);
  return (saved?.seconds ?? 0) + unsaved;
}

function beep() {
  try {
    const ctx = new AudioContext();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.32);
    });
  } catch {
    /* 音が出せない環境では鳴らさない */
  }
}

export function StudyTimer({ binderId }: { binderId: string }) {
  const todaySeconds = useStudyTracker(binderId);
  const settings = useSettings();
  const [phase, setPhase] = useState<'work' | 'break'>('work');
  const [running, setRunning] = useState(false);
  const [endAt, setEndAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(settings.pomodoroWork * 60);
  const [, force] = useState(0);

  useEffect(() => {
    if (!running) setRemaining((phase === 'work' ? settings.pomodoroWork : settings.pomodoroBreak) * 60);
    // 設定変更時は止まっているタイマーだけ更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.pomodoroWork, settings.pomodoroBreak]);

  useEffect(() => {
    if (!running || !endAt) return;
    const t = setInterval(() => {
      const left = (endAt - Date.now()) / 1000;
      if (left <= 0) {
        beep();
        const next = phase === 'work' ? 'break' : 'work';
        const msg = next === 'break' ? 'おつかれさま！休憩しましょう ☕' : '休憩終わり。集中タイムです ✏️';
        toast(msg);
        if ('Notification' in window && Notification.permission === 'granted') new Notification('Study Sakura', { body: msg });
        setPhase(next);
        setRunning(false);
        setEndAt(null);
        setRemaining((next === 'work' ? settings.pomodoroWork : settings.pomodoroBreak) * 60);
      } else {
        setRemaining(left);
        force((x) => x + 1);
      }
    }, 250);
    return () => clearInterval(t);
  }, [running, endAt, phase, settings.pomodoroWork, settings.pomodoroBreak]);

  const toggle = () => {
    if (running) {
      setRunning(false);
      setEndAt(null);
    } else {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      setEndAt(Date.now() + remaining * 1000);
      setRunning(true);
    }
  };
  const reset = () => {
    setRunning(false);
    setEndAt(null);
    setPhase('work');
    setRemaining(settings.pomodoroWork * 60);
  };

  return (
    <div className="study-timer">
      <span className="today-time" title="このバインダーでの今日の学習時間（自動記録）">⏱ 今日 {formatDuration(todaySeconds)}</span>
      <div className={`pomodoro ${phase}${running ? ' running' : ''}`}>
        <button className="pomo-main" onClick={toggle} title={running ? '一時停止' : 'ポモドーロを開始'}>
          <span>{phase === 'work' ? '🍅' : '☕'}</span>
          <span className="pomo-clock">{formatClock(remaining)}</span>
          <span>{running ? '❚❚' : '▶'}</span>
        </button>
        <button className="icon-btn tiny" onClick={reset} title="リセット" aria-label="ポモドーロをリセット">↺</button>
      </div>
    </div>
  );
}
