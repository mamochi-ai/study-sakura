import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

/* ---------- 汎用モーダル ---------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 440,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- prompt / confirm を Promise で呼べるダイアログ ---------- */

type DialogRequest =
  | { kind: 'prompt'; title: string; label?: string; value: string; placeholder?: string; multiline?: boolean; preview?: (v: string) => ReactNode; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; message: string; danger?: boolean; okLabel?: string; resolve: (v: boolean) => void };

let current: DialogRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function askText(opts: { title: string; label?: string; value?: string; placeholder?: string; multiline?: boolean; preview?: (v: string) => ReactNode }) {
  return new Promise<string | null>((resolve) => {
    current = { kind: 'prompt', value: '', ...opts, resolve };
    emit();
  });
}

export function confirmDialog(opts: { title: string; message: string; danger?: boolean; okLabel?: string }) {
  return new Promise<boolean>((resolve) => {
    current = { kind: 'confirm', ...opts, resolve };
    emit();
  });
}

export function DialogHost() {
  const req = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  if (!req) return null;
  const close = () => {
    current = null;
    emit();
  };
  if (req.kind === 'confirm') {
    const done = (v: boolean) => {
      close();
      req.resolve(v);
    };
    return (
      <Modal
        title={req.title}
        onClose={() => done(false)}
        footer={
          <>
            <button className="btn" onClick={() => done(false)}>キャンセル</button>
            <button className={req.danger ? 'btn danger' : 'btn primary'} autoFocus onClick={() => done(true)}>
              {req.okLabel ?? 'OK'}
            </button>
          </>
        }
      >
        <p style={{ whiteSpace: 'pre-wrap' }}>{req.message}</p>
      </Modal>
    );
  }
  return <PromptDialog key={req.title} req={req} close={close} />;
}

function PromptDialog({ req, close }: { req: Extract<DialogRequest, { kind: 'prompt' }>; close: () => void }) {
  const [value, setValue] = useState(req.value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const done = (v: string | null) => {
    close();
    req.resolve(v);
  };
  const Field = req.multiline ? 'textarea' : 'input';
  return (
    <Modal
      title={req.title}
      onClose={() => done(null)}
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>キャンセル</button>
          <button className="btn primary" onClick={() => done(value)}>OK</button>
        </>
      }
    >
      <label className="field">
        {req.label && <span>{req.label}</span>}
        <Field
          ref={ref}
          value={value}
          placeholder={req.placeholder}
          rows={req.multiline ? 4 : undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (!req.multiline || e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              done(value);
            }
          }}
        />
      </label>
      {req.preview && <div className="prompt-preview">{req.preview(value)}</div>}
    </Modal>
  );
}

/* ---------- トースト ---------- */

let toasts: { id: number; text: string }[] = [];
const toastListeners = new Set<() => void>();
export function toast(text: string) {
  const id = Date.now() + Math.random();
  toasts = [...toasts, { id, text }];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    toastListeners.forEach((l) => l());
  }, 2600);
}

export function ToastHost() {
  const list = useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toasts,
  );
  return (
    <div className="toast-host" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">{t.text}</div>
      ))}
    </div>
  );
}
