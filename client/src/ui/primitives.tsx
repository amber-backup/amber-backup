import { useState, type ReactNode } from 'react';
import { Icon } from '../core/icons';

/** Labelled form field: label, control, optional help text. */
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {help && <span className="help">{help}</span>}
    </div>
  );
}

/** Standard page header with title, subtitle, and action buttons. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="topbar">
      <div className="page-title">
        <h1>{title}</h1>
        {subtitle != null && <p>{subtitle}</p>}
      </div>
      <div className="topbar-actions">{actions}</div>
    </div>
  );
}

/** Header/toolbar button with an icon and a label (matches old actionButton). */
export function ActionButton({
  label,
  icon,
  onClick,
  variant = 'ghost',
  disabled,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
}) {
  return (
    <button className={`btn btn-${variant}`} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

/**
 * A button that disables itself and (optionally) shows a busy label while its
 * async `onClick` is running. Replaces the old imperative disable/relabel dance
 * on test/run/generate buttons.
 */
export function BusyButton({
  className,
  onClick,
  children,
  busyLabel,
  title,
  disabled,
}: {
  className: string;
  onClick: () => void | Promise<void>;
  children: ReactNode;
  busyLabel?: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      title={title}
      disabled={busy || disabled}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy && busyLabel != null ? busyLabel : children}
    </button>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Loading({ label }: { label?: string }) {
  return (
    <div className="loading">
      <Spinner />
      {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
