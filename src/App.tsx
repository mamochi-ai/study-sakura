import { useEffect, useState } from 'react';
import { DialogHost, ToastHost } from './components/Modal';
import { applyTheme, useSettings } from './lib/settings';
import DeskView from './views/DeskView';
import StudyView from './views/StudyView';

type Route = { kind: 'desk' } | { kind: 'study'; binderId: string };
const ROUTE_KEY = 'study-sakura:route';

function loadRoute(): Route {
  try {
    const r = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null');
    if (r?.kind === 'study' && typeof r.binderId === 'string') return r;
  } catch {
    /* noop */
  }
  return { kind: 'desk' };
}

export default function App() {
  const [route, setRoute] = useState<Route>(loadRoute);
  const settings = useSettings();

  useEffect(() => {
    applyTheme(settings.theme);
    if (settings.theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [settings.theme]);

  useEffect(() => {
    try {
      sessionStorage.setItem(ROUTE_KEY, JSON.stringify(route));
    } catch {
      /* noop */
    }
  }, [route]);

  return (
    <>
      {route.kind === 'desk' ? (
        <DeskView onOpenBinder={(binderId) => setRoute({ kind: 'study', binderId })} />
      ) : (
        <StudyView key={route.binderId} binderId={route.binderId} onBack={() => setRoute({ kind: 'desk' })} />
      )}
      <DialogHost />
      <ToastHost />
    </>
  );
}
