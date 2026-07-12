import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../core/icons';

// --- Modal chrome ---------------------------------------------------------

/** The standard modal card (head + body + optional footer). Editors compose
 *  their own footer; info dialogs pass none. */
export function ModalFrame({
  title,
  wide,
  onClose,
  footer,
  children,
}: {
  title: string;
  wide?: boolean;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="modal" style={wide ? { maxWidth: 720 } : undefined}>
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="btn-icon" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  );
}

/**
 * A modal wrapping a form. `onSubmit` runs on confirm; returning `false` keeps
 * the modal open (validation failed), anything else closes it. The confirm
 * button is disabled while the submit is in flight — mirrors the old openModal.
 */
export function FormModal({
  title,
  wide,
  confirmLabel = 'Save',
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  wide?: boolean;
  confirmLabel?: string;
  onClose: () => void;
  onSubmit: () => boolean | void | Promise<boolean | void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const result = await onSubmit();
      if (result !== false) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalFrame
      title={title}
      wide={wide}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </ModalFrame>
  );
}

// --- Modal host / imperative API ------------------------------------------

interface ModalEntry {
  id: number;
  render: (close: () => void) => ReactNode;
}

interface ModalContextValue {
  /** Mounts a modal; the render fn receives its own `close`. Returns `close`. */
  open: (render: (close: () => void) => ReactNode) => { close: () => void };
  /** Convenience confirm/delete dialog. */
  confirmDialog: (
    title: string,
    message: string,
    onConfirm: () => void | Promise<void>,
    danger?: boolean,
  ) => void;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ModalEntry[]>([]);
  const nextId = useRef(0);

  const close = useCallback((id: number) => {
    setEntries((cur) => cur.filter((e) => e.id !== id));
  }, []);

  const open = useCallback<ModalContextValue['open']>(
    (render) => {
      const id = nextId.current++;
      setEntries((cur) => [...cur, { id, render }]);
      return { close: () => close(id) };
    },
    [close],
  );

  const confirmDialog = useCallback<ModalContextValue['confirmDialog']>(
    (title, message, onConfirm, danger = false) => {
      open((closeThis) => (
        <FormModal
          title={title}
          confirmLabel={danger ? 'Delete' : 'Confirm'}
          onClose={closeThis}
          onSubmit={onConfirm}
        >
          {danger ? <div className="warn-box">{message}</div> : <p>{message}</p>}
        </FormModal>
      ));
    },
    [open],
  );

  const root = document.getElementById('modal-root');

  return (
    <ModalContext.Provider value={{ open, confirmDialog }}>
      {children}
      {root &&
        createPortal(
          entries.map((e) => {
            const closeThis = () => close(e.id);
            return (
              // Each modal has its own backdrop so one modal can open another
              // without the first's close wiping out the second. Backdrop click
              // closes only when the click lands on the backdrop itself.
              <div
                key={e.id}
                className="modal-backdrop"
                onClick={(ev) => {
                  if (ev.target === ev.currentTarget) closeThis();
                }}
              >
                {e.render(closeThis)}
              </div>
            );
          }),
          root,
        )}
    </ModalContext.Provider>
  );
}

export function useModal(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal must be used within a ModalProvider');
  return ctx;
}
