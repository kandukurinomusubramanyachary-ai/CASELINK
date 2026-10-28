import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError } from './api';
import { createPortal } from 'react-dom';
import { Icon } from './components/Icon';
import { classNames, deadlineTone, DEADLINE_LABEL, STATUS_TONE } from './util';

/* ----------------------------------------------------------------- badges */
let modalCount = 0;
let originalBodyOverflow = '';

export function Pill({
  children,
  tone = 'slate',
  dot = false,
  title,
}: {
  children: React.ReactNode;
  tone?: string;
  dot?: boolean;
  title?: string;
}) {
  return (
    <span className={classNames('pill', `pill-${tone}`)} title={title}>
      {dot && <span className="pill-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  return (
    <Pill tone={STATUS_TONE[status] ?? 'slate'} dot>
      {status}
    </Pill>
  );
}

export function DeadlineChip({ state }: { state: string }) {
  return <Pill tone={deadlineTone(state)}>{DEADLINE_LABEL[state] ?? state}</Pill>;
}

export function PriorityChip({ priority }: { priority: { band: string; score: number; reasons: string[] } }) {
  if (!priority || priority.band === 'Normal') return <Pill tone="slate">Normal</Pill>;
  return (
    <Pill tone={priority.band === 'Critical' ? 'red' : 'amber'} title={priority.reasons.join(' · ')}>
      {priority.band} ({priority.score})
    </Pill>
  );
}

export function MaskedBadge() {
  return (
    <Pill tone="violet" title="Coordination metadata only — complaint text, contact, evidence and history remarks are restricted">
      Restricted
    </Pill>
  );
}

/* ----------------------------------------------------------------- layout */

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  footer,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  footer?: React.ReactNode;
}) {
  return (
    <section className={classNames('card', className)}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
      {footer && <footer className="card-foot">{footer}</footer>}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'slate',
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: string;
  onClick?: () => void;
}) {
  const Inner = onClick ? 'button' : 'div';
  return (
    <Inner className={classNames('stat', `stat-${tone}`, value === 0 && 'stat-zero', onClick && 'stat-click')} onClick={onClick} title={hint}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </Inner>
  );
}

export function Loading({ label = 'Loading…', rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
      <div className="skeleton-stack" aria-hidden="true">
        {Array.from({ length: rows }).map((_, i) => (
          <span key={i} className="skeleton" />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  tone = 'slate',
}: {
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className={classNames('empty', `empty-${tone}`)}>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  if (!error) return null;
  const api = error as ApiError;
  return (
    <div className="error-note" role="alert">
      <strong>{api.code === 'access_denied' ? 'Access denied' : api.code === 'stale_version' ? 'Record changed' : 'Something needs attention'}</strong>
      <p>{error.message}</p>
      {api.fields && Object.keys(api.fields).length > 0 && (
        <ul className="field-errors">
          {Object.entries(api.fields).map(([field, message]) => (
            <li key={field}>
              <code>{field}</code> — {message}
            </li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: string; children: React.ReactNode }) {
  return <div className={classNames('notice', `notice-${tone}`)}>{children}</div>;
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  const hintId = useId();
  const errorId = useId();
  const control = React.isValidElement(children) && typeof children.type === 'string' && ['input', 'select', 'textarea'].includes(children.type)
    ? React.cloneElement(children as React.ReactElement<any>, { 'aria-invalid': Boolean(error), 'aria-required': Boolean(required), 'aria-describedby': [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined })
    : children;
  return (
    <label className={classNames('field', error && 'field-invalid')} htmlFor={htmlFor}>
      <span className="field-label">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </span>
      {control}
      {hint && <span className="field-hint" id={hintId}>{hint}</span>}
      {error && (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  drawer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (modalCount === 0) originalBodyOverflow = document.body.style.overflow;
    modalCount += 1;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    dialog.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button')?.focus({ preventScroll: true });
    if (document.documentElement.dataset.input === 'pointer' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dialog.animate([
        { opacity: 0, transform: drawer ? 'translateX(-12px)' : 'translateY(6px) scale(.985)' },
        { opacity: 1, transform: 'none' },
      ], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    return () => {
      dialog.close();
      modalCount -= 1;
      if (modalCount === 0) document.body.style.overflow = originalBodyOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [drawer]);
  return createPortal(
      <dialog className={classNames('modal', wide && 'modal-wide', drawer && 'modal-drawer')} aria-label={title} ref={ref}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button,input,select,textarea,summary,a[href],[tabindex="0"]')].filter(element => !element.matches(':disabled') && element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (!first) { event.preventDefault(); event.currentTarget.focus(); }
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}
        onCancel={(event) => { event.preventDefault(); onClose(); }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
        }}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close dialog">
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </dialog>, document.body
  );
}

/* ----------------------------------------------------------------- toasts */

type Toast = { id: number; tone: 'success' | 'error' | 'info'; title: string; body?: string };
const ToastContext = createContext<{ push: (t: Omit<Toast, 'id'>) => void }>({ push: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 6000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={classNames('toast', `toast-${t.tone}`)}>
            <strong>{t.title}</strong>
            {t.body && <p>{t.body}</p>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* ---------------------------------------------------------------- tables */

export function DataTable({
  head,
  children,
  empty,
  caption,
}: {
  head: React.ReactNode[];
  children: React.ReactNode;
  empty?: React.ReactNode;
  caption?: string;
}) {
  const hasRows = React.Children.count(children) > 0;
  return (
    <div className="table-wrap">
      <table className="data">
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{hasRows ? children : <tr><td colSpan={head.length}>{empty ?? 'No records.'}</td></tr>}</tbody>
      </table>
    </div>
  );
}

export function Bar({ value, max, tone = 'indigo', label }: { value: number; max: number; tone?: string; label: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className={classNames('bar-fill', `bar-${tone}`)} style={{ width: `${Math.max(pct, value > 0 ? 3 : 0)}%` }} />
      </span>
      <span className="bar-value">{value}</span>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={active === t.id}
          className={classNames('tab', active === t.id && 'tab-active')}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      aria-label={label}
      disabled={busy}
      aria-busy={busy}
      onClick={async () => {
        setBusy(true); setCopied(false);
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Select the displayed value and copy it manually.');
          await navigator.clipboard.writeText(value);
          setCopied(true);
          push({ tone: 'success', title: 'Copied to clipboard' });
        } catch (error) { push({ tone: 'error', title: 'Could not copy', body: error instanceof Error ? error.message : 'Clipboard permission was denied. Select and copy the value manually.' }); }
        finally { setBusy(false); }
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={15} />{busy ? 'Copying…' : copied ? 'Copied' : label}
    </button>
  );
}
