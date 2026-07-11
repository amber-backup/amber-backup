import { h } from './dom';
import { icon } from './icons';

// --- Toasts ---

export function toast(
  message: string,
  kind: 'info' | 'success' | 'error' = 'info',
): void {
  const root = document.getElementById('toast-root')!;
  const el = h('div', { class: `toast ${kind}` }, message);
  root.append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, 3800);
}

// --- Clipboard ---

/**
 * Copies text to the clipboard. The async Clipboard API only exists in secure
 * contexts (HTTPS or localhost); over plain HTTP `navigator.clipboard` is
 * undefined, so fall back to a hidden textarea + execCommand. Returns whether
 * the copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// --- Modal ---

export interface ModalOptions {
  title: string;
  body: Node;
  confirmLabel?: string;
  onConfirm?: () => boolean | void | Promise<boolean | void>;
  wide?: boolean;
}

export function openModal(opts: ModalOptions): { close: () => void } {
  const root = document.getElementById('modal-root')!;
  const confirmBtn = h(
    'button',
    { class: 'btn btn-primary' },
    opts.confirmLabel ?? 'Save',
  );

  // Remove only this modal's own backdrop, not everything in the root. That
  // lets one modal open another (e.g. "key created" from the create dialog)
  // without the first modal's close wiping out the second.
  const close = () => backdrop.remove();

  confirmBtn.addEventListener('click', async () => {
    if (!opts.onConfirm) return close();
    confirmBtn.setAttribute('disabled', '');
    try {
      const result = await opts.onConfirm();
      if (result !== false) close();
    } finally {
      confirmBtn.removeAttribute('disabled');
    }
  });

  const modal = h(
    'div',
    { class: 'modal', style: opts.wide ? 'max-width: 720px' : '' },
    h(
      'div',
      { class: 'modal-head' },
      h('h2', {}, opts.title),
      h('button', { class: 'btn-icon', onclick: close }, icon('x')),
    ),
    h('div', { class: 'modal-body' }, opts.body),
    h(
      'div',
      { class: 'modal-foot' },
      h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'),
      opts.onConfirm ? confirmBtn : (null as never),
    ),
  );

  const backdrop = h(
    'div',
    {
      class: 'modal-backdrop',
      onclick: (e: MouseEvent) => {
        if (e.target === backdrop) close();
      },
    },
    modal,
  );
  root.replaceChildren(backdrop);
  return { close };
}

export function confirmDialog(
  title: string,
  message: string,
  onConfirm: () => void | Promise<void>,
  danger = false,
): void {
  openModal({
    title,
    body: danger
      ? h('div', { class: 'warn-box' }, message)
      : h('p', {}, message),
    confirmLabel: danger ? 'Delete' : 'Confirm',
    onConfirm,
  });
}

// --- Form field builders ---

export function field(
  label: string,
  input: HTMLElement,
  help?: string,
): HTMLElement {
  return h(
    'div',
    { class: 'field' },
    h('label', {}, label),
    input,
    help ? h('span', { class: 'help' }, help) : (null as never),
  );
}

// --- Formatting ---

export function fmtBytes(bytes?: number | null): string {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function fmtRelative(date?: string | null): string {
  if (!date) return '—';
  const diff = Date.now() - new Date(date).getTime();
  const abs = Math.abs(diff);
  const min = 60_000, hour = 3_600_000, day = 86_400_000;
  const ago = diff >= 0;
  const fmt = (n: number, unit: string) => (ago ? `${n} ${unit} ago` : `in ${n} ${unit}`);
  if (abs < min) return ago ? 'just now' : 'soon';
  if (abs < hour) return fmt(Math.round(abs / min), 'min');
  if (abs < day) return fmt(Math.round(abs / hour), 'h');
  if (abs < 30 * day) return fmt(Math.round(abs / day), 'd');
  return new Date(date).toLocaleDateString('en-US');
}

export function fmtDateTime(date?: string | null): string {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    queued: 'queued',
    running: 'running',
    success: 'success',
    failed: 'failed',
    cancelled: 'cancelled',
    online: 'online',
    offline: 'offline',
    enrolled: 'connecting',
    error: 'error',
  };
  return map[status] ?? status;
}
