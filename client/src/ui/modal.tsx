import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../core/icons';
import { useToast } from './toast';
import { useT } from '../i18n';

// --- Focus helpers --------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const FIELDS = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])';

function visible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
}

function firstField(root: HTMLElement): HTMLElement | null {
  const body = root.querySelector<HTMLElement>('.modal-body');
  if (!body) return null;
  return Array.from(body.querySelectorAll<HTMLElement>(FIELDS)).find(visible) ?? null;
}

/** Open modal frames, bottom to top. Only the top-most one reacts to Esc and
 *  keeps the focus trapped — a confirm stacked on an editor owns the keyboard. */
const frameStack: symbol[] = [];
const isTop = (me: symbol) => frameStack[frameStack.length - 1] === me;

// --- Modal chrome ---------------------------------------------------------

/** The standard modal card (head + body + optional footer). Editors compose
 *  their own footer; info dialogs pass none.
 *
 *  Keyboard behaviour: it is a labelled `role="dialog"`, focus moves to the
 *  first field on open (or the `[data-autofocus]` element, else the first
 *  footer button), Tab cycles inside the top-most modal, Esc closes it (asking
 *  first when a field was changed) and focus returns to the trigger on close. */
export function ModalFrame({
  title,
  wide,
  onClose,
  footer,
  guardChanges = true,
  children,
}: {
  title: string;
  wide?: boolean;
  onClose: () => void;
  footer?: ReactNode;
  /** Esc asks before discarding once a field was changed (default on). */
  guardChanges?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const modal = useContext(ModalContext);
  const dirty = useRef(false);
  const asking = useRef(false);
  // Latest callbacks for the document listeners registered once on mount.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const me = Symbol('modal');
    frameStack.push(me);
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current!;

    // Initial focus. Content that loads after the open (e.g. a snapshot list)
    // still gets it, as long as the user has not moved the focus themselves.
    const initial = (): HTMLElement => {
      const foot = el.querySelector<HTMLElement>('.modal-foot');
      return (
        firstField(el) ??
        el.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ??
        (foot ? focusables(foot)[0] : undefined) ??
        el
      );
    };
    let fallback: HTMLElement | null = initial();
    fallback.focus();
    if (firstField(el)) fallback = null;
    const observer = new MutationObserver(() => {
      if (!fallback) return;
      if (document.activeElement !== fallback && document.activeElement !== document.body) {
        fallback = null;
        observer.disconnect();
        return;
      }
      const field = firstField(el);
      if (field) {
        field.focus();
        fallback = null;
        observer.disconnect();
      }
    });
    if (fallback) observer.observe(el, { childList: true, subtree: true });
    const stopWatching = () => {
      fallback = null;
      observer.disconnect();
    };
    el.addEventListener('pointerdown', stopWatching);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop(me)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const ctx = modalRef.current;
        if (guardChanges && dirty.current && ctx) {
          if (asking.current) return;
          asking.current = true;
          const m = tRef.current.common;
          void ctx
            .confirm({ title: m.discardTitle, message: m.discardMessage, confirmLabel: m.discard, danger: true })
            .then((ok) => {
              asking.current = false;
              if (ok) onCloseRef.current();
            });
          return;
        }
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        stopWatching();
        const items = focusables(el);
        if (items.length === 0) {
          e.preventDefault();
          el.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        const inside = active instanceof Node && el.contains(active);
        if (e.shiftKey && (!inside || active === first || active === el)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (!inside || active === last)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // Focus that lands outside the top-most modal (e.g. via a click on the page
    // behind a stacked modal) is pulled back in.
    const onFocusIn = (e: FocusEvent) => {
      if (!isTop(me)) return;
      const target = e.target;
      if (target instanceof Node && !el.contains(target)) {
        (focusables(el)[0] ?? el).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);

    return () => {
      observer.disconnect();
      el.removeEventListener('pointerdown', stopWatching);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      const i = frameStack.indexOf(me);
      if (i >= 0) frameStack.splice(i, 1);
      // Return the focus to whatever opened the modal, if it still exists. A
      // trigger that is momentarily disabled (the busy confirm button of the
      // dialog underneath) gets it a few frames later, unless focus moved on.
      const giveBack = (tries: number) => {
        if (!trigger || !trigger.isConnected) return;
        const idle = document.activeElement === null || document.activeElement === document.body;
        if (!idle && tries < 10) return;
        if (trigger.matches(':disabled')) {
          if (tries > 0) requestAnimationFrame(() => giveBack(tries - 1));
          return;
        }
        trigger.focus();
      };
      giveBack(10);
    };
  }, []);

  const markDirty = () => {
    dirty.current = true;
  };

  return (
    <div
      ref={ref}
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={wide ? { maxWidth: 720 } : undefined}
    >
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button className="btn-icon" onClick={onClose} aria-label={t.common.close}>
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body" onInput={markDirty} onChange={markDirty}>
        {children}
      </div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  );
}

/**
 * A modal wrapping a form. `onSubmit` runs on confirm; returning `false` keeps
 * the modal open (validation failed), anything else closes it. The confirm
 * button is disabled while the submit is in flight — mirrors the old openModal.
 * `danger` renders the confirm button as a filled red button (irreversible
 * actions); `confirmDisabled` keeps it disabled (e.g. until a check passes).
 */
export function FormModal({
  title,
  wide,
  confirmLabel,
  danger,
  confirmDisabled,
  guardChanges,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  wide?: boolean;
  confirmLabel?: string;
  danger?: boolean;
  confirmDisabled?: boolean;
  guardChanges?: boolean;
  onClose: () => void;
  onSubmit: () => boolean | void | Promise<boolean | void>;
  children: ReactNode;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const submit = async () => {
    setBusy(true);
    try {
      const result = await onSubmit();
      if (result !== false) onClose();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <ModalFrame
      title={title}
      wide={wide}
      onClose={onClose}
      guardChanges={guardChanges}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button
            className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`}
            disabled={busy || confirmDisabled}
            onClick={submit}
            data-autofocus={danger ? undefined : ''}
          >
            {confirmLabel ?? t.common.save}
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

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  /** Label of the confirm button; defaults to "Confirm" ("Delete" for danger). */
  confirmLabel?: string;
  /** Red, filled confirm button and the message in a warning box. */
  danger?: boolean;
  /** The confirm button stays disabled until exactly this text was typed. */
  requireText?: string;
}

interface ModalContextValue {
  /** Mounts a modal; the render fn receives its own `close`. Returns `close`. */
  open: (render: (close: () => void) => ReactNode) => { close: () => void };
  /** Convenience confirm/delete dialog: runs `onConfirm` on confirm, keeps the
   *  dialog open and toasts the error when it throws. */
  confirmDialog: (
    title: string,
    message: string,
    onConfirm: () => void | Promise<void>,
    danger?: boolean,
    opts?: { confirmLabel?: string },
  ) => void;
  /** Promise-based confirmation: true on confirm, false on cancel/Esc/close. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ModalContext = createContext<ModalContextValue | null>(null);

function ConfirmMessage({ message, danger }: { message: ReactNode; danger?: boolean }) {
  if (danger) return <div className="warn-box">{message}</div>;
  return typeof message === 'string' ? <p>{message}</p> : <div>{message}</div>;
}

function ConfirmModal({
  opts,
  onConfirm,
  onClose,
}: {
  opts: ConfirmOptions;
  onConfirm: () => void | boolean | Promise<void | boolean>;
  onClose: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const label = opts.confirmLabel ?? (opts.danger ? t.common.delete : t.common.confirm);
  return (
    <FormModal
      title={opts.title}
      confirmLabel={label}
      danger={opts.danger}
      confirmDisabled={opts.requireText !== undefined && typed !== opts.requireText}
      guardChanges={false}
      onClose={onClose}
      onSubmit={onConfirm}
    >
      <ConfirmMessage message={opts.message} danger={opts.danger} />
      {opts.requireText !== undefined && (
        <div className="field">
          <label htmlFor={inputId}>{t.common.typeToConfirm(opts.requireText)}</label>
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      )}
    </FormModal>
  );
}

export function ModalProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ModalEntry[]>([]);
  const nextId = useRef(0);
  const toast = useToast();
  const t = useT();

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
    (title, message, onConfirm, danger = false, opts) => {
      // Surface a failing confirm action (e.g. a 409 from the API) as a toast
      // and keep the dialog open, instead of letting the error vanish silently.
      const submit = async () => {
        try {
          await onConfirm();
        } catch (err) {
          toast(err instanceof Error ? err.message : t.common.actionFailed, 'error');
          return false;
        }
      };
      open((closeThis) => (
        <ConfirmModal
          opts={{ title, message, danger, confirmLabel: opts?.confirmLabel }}
          onConfirm={submit}
          onClose={closeThis}
        />
      ));
    },
    [open, toast, t],
  );

  const confirm = useCallback<ModalContextValue['confirm']>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (value: boolean) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        open((closeThis) => (
          <ConfirmModal
            opts={opts}
            onConfirm={() => settle(true)}
            onClose={() => {
              settle(false);
              closeThis();
            }}
          />
        ));
      }),
    [open],
  );

  const root = document.getElementById('modal-root');

  return (
    <ModalContext.Provider value={{ open, confirmDialog, confirm }}>
      {children}
      {root &&
        createPortal(
          entries.map((e) => {
            const closeThis = () => close(e.id);
            return (
              // Each modal has its own backdrop so one modal can open another
              // without the first's close wiping out the second. Clicking the
              // backdrop does not close the modal — only the X, Cancel or Esc
              // does, so a stray click can't discard a half-filled form.
              <div key={e.id} className="modal-backdrop">
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
