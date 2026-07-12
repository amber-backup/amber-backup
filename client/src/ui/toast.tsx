import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type ToastKind = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  leaving: boolean;
}

type ToastFn = (message: string, kind?: ToastKind) => void;

const ToastContext = createContext<ToastFn | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const toast = useCallback<ToastFn>((message, kind = 'info') => {
    const id = nextId.current++;
    setItems((cur) => [...cur, { id, message, kind, leaving: false }]);
    // Match the original: hold ~3.8s, fade for 200ms, then remove.
    setTimeout(() => {
      setItems((cur) => cur.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 200);
    }, 3800);
  }, []);

  const root = document.getElementById('toast-root');

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {root &&
        createPortal(
          items.map((t) => (
            <div
              key={t.id}
              className={`toast ${t.kind}`}
              style={t.leaving ? { opacity: 0 } : undefined}
            >
              {t.message}
            </div>
          )),
          root,
        )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
