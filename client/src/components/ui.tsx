import { useEffect, useRef, useState } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { initials } from '../lib/format';

/* ---------------------------------------------------------------- */
/* Icons - single stroke set keeps the UI visually consistent        */
/* ---------------------------------------------------------------- */

type IconName =
  | 'play' | 'pause' | 'next' | 'prev' | 'plus' | 'close' | 'search' | 'settings' | 'users' | 'chat'
  | 'list' | 'home' | 'shield' | 'logout' | 'link' | 'trash' | 'shuffle' | 'repeat' | 'repeat-one'
  | 'volume' | 'mute' | 'menu' | 'check' | 'copy' | 'upload' | 'lock' | 'globe' | 'star' | 'edit'
  | 'expand' | 'collapse' | 'grip' | 'save' | 'refresh' | 'chevron-down' | 'sync' | 'chart' | 'captions' | 'panel-left' | 'panel-right' | 'bug';

const PATHS: Record<IconName, ReactNode> = {
  play: <path d="M6 4.5v15l12-7.5z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" /></>,
  next: <><path d="M5 5l10 7-10 7z" fill="currentColor" stroke="none" /><rect x="17" y="5" width="2.6" height="14" rx="1" fill="currentColor" stroke="none" /></>,
  prev: <><path d="M19 5L9 12l10 7z" fill="currentColor" stroke="none" /><rect x="4.4" y="5" width="2.6" height="14" rx="1" fill="currentColor" stroke="none" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 00.32 1.77l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.6 1.6 0 00-1.77-.32 1.6 1.6 0 00-1 1.47V21a2 2 0 11-4 0v-.11a1.6 1.6 0 00-1.05-1.46 1.6 1.6 0 00-1.77.32l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.6 1.6 0 00.32-1.77 1.6 1.6 0 00-1.47-1H3a2 2 0 110-4h.11a1.6 1.6 0 001.46-1.05 1.6 1.6 0 00-.32-1.77l-.06-.06a2 2 0 112.83-2.83l.06.06a1.6 1.6 0 001.77.32H9a1.6 1.6 0 001-1.47V3a2 2 0 114 0v.11a1.6 1.6 0 001 1.47 1.6 1.6 0 001.77-.32l.06-.06a2 2 0 112.83 2.83l-.06.06a1.6 1.6 0 00-.32 1.77V9a1.6 1.6 0 001.47 1H21a2 2 0 110 4h-.11a1.6 1.6 0 00-1.47 1z" /></>,
  users: <><path d="M16 20v-1.8a3.6 3.6 0 00-3.6-3.6H6.6A3.6 3.6 0 003 18.2V20" /><circle cx="9.5" cy="7.5" r="3.4" /><path d="M21 20v-1.8a3.6 3.6 0 00-2.7-3.48M15.5 4.2a3.6 3.6 0 010 6.9" /></>,
  chat: <path d="M20 12a7.5 7.5 0 01-7.5 7.5 8 8 0 01-3.4-.75L4 20l1.3-4.4A7.5 7.5 0 1120 12z" />,
  list: <path d="M8 6h12M8 12h12M8 18h8M4 6h.01M4 12h.01M4 18h.01" />,
  home: <><path d="M3 10.5L12 3l9 7.5" /><path d="M5.5 9.5V20h13V9.5" /></>,
  shield: <path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.4-7.5 9.5-4.4-1.1-7.5-4.9-7.5-9.5V6z" />,
  logout: <><path d="M15 17l5-5-5-5" /><path d="M20 12H9" /><path d="M11 4H6a2 2 0 00-2 2v12a2 2 0 002 2h5" /></>,
  link: <><path d="M10.5 13.5a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1.5 1.5" /><path d="M13.5 10.5a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1.5-1.5" /></>,
  trash: <><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" /><path d="M6.5 7l.8 12.1a1.8 1.8 0 001.8 1.7h5.8a1.8 1.8 0 001.8-1.7L17.5 7" /></>,
  shuffle: <><path d="M17 4l3 3-3 3M17 14l3 3-3 3" /><path d="M4 7h3.5l9 10H20M4 17h3.5l2.6-2.9M14 9.4L16.5 7H20" /></>,
  repeat: <><path d="M17 2l3 3-3 3" /><path d="M20 5H8a4 4 0 00-4 4v1" /><path d="M7 22l-3-3 3-3" /><path d="M4 19h12a4 4 0 004-4v-1" /></>,
  'repeat-one': <><path d="M17 2l3 3-3 3" /><path d="M20 5H8a4 4 0 00-4 4v1" /><path d="M7 22l-3-3 3-3" /><path d="M4 19h12a4 4 0 004-4v-1" /><path d="M12 10.5l1.3-.8v4.6" /></>,
  volume: <><path d="M11 5L6.5 9H3v6h3.5L11 19z" /><path d="M15.5 9.2a4 4 0 010 5.6M18.2 6.5a8 8 0 010 11" /></>,
  mute: <><path d="M11 5L6.5 9H3v6h3.5L11 19z" /><path d="M16 10l4 4M20 10l-4 4" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 012-2h9" /></>,
  upload: <><path d="M12 16V4M7.5 8.5L12 4l4.5 4.5" /><path d="M4 16v2.5A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5V16" /></>,
  lock: <><rect x="4.5" y="10.5" width="15" height="10" rx="2.2" /><path d="M8 10.5V7.8a4 4 0 018 0v2.7" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.4 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.4-3.3-8.5S9.8 5.9 12 3.5z" /></>,
  star: <path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z" />,
  edit: <><path d="M4 20h4L19 9a2.4 2.4 0 10-3.4-3.4L4.6 16.6z" /><path d="M14.5 6.5l3 3" /></>,
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  collapse: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  grip: <><circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none" /></>,
  save: <><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v6h7V4M8 20v-6h8v6" /></>,
  refresh: <><path d="M20 12a8 8 0 11-2.6-5.9" /><path d="M20 4v5h-5" /></>,
  'chevron-down': <path d="M6 9.5l6 6 6-6" />,
  captions: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M9 10.5a2 2 0 100 3M16 10.5a2 2 0 100 3" /></>,
  'panel-left': <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></>,
  'panel-right': <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M15 4v16" /></>,
  bug: <><path d="M8 7a4 4 0 018 0" /><rect x="6" y="7" width="12" height="12" rx="5" /><path d="M3 11h3M18 11h3M3 17h3.5M17.5 17H21M12 12v6" /></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  sync: <><path d="M4 12a8 8 0 0113.7-5.6L20 8" /><path d="M20 4v4h-4" /><path d="M20 12a8 8 0 01-13.7 5.6L4 16" /><path d="M4 20v-4h4" /></>,
};

export function Icon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/* ---------------------------------------------------------------- */
/* Brand                                                             */
/* ---------------------------------------------------------------- */

export function Brand({ large, name = 'Watch With Friends' }: { large?: boolean; name?: string }) {
  return (
    <div className={`brand${large ? ' lg' : ''}`}>
      <span className="brand-mark">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
        </svg>
      </span>
      <span>{name}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Avatar                                                            */
/* ---------------------------------------------------------------- */

export function Avatar({
  name,
  color,
  url,
  size = 'md',
}: {
  name: string;
  color: string;
  /** Profile picture; initials are the fallback. */
  url?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const cls = size === 'md' ? 'avatar' : `avatar ${size}`;
  const [broken, setBroken] = useState(false);

  // A deleted picture should degrade to initials, not a broken image icon.
  useEffect(() => setBroken(false), [url]);

  if (url && !broken) {
    return (
      <img
        className={cls}
        src={url}
        alt={name}
        title={name}
        loading="lazy"
        onError={() => setBroken(true)}
        style={{ objectFit: 'cover', background: color }}
      />
    );
  }
  return (
    <span className={cls} style={{ background: color }} title={name}>
      {initials(name)}
    </span>
  );
}

/* ---------------------------------------------------------------- */
/* Toggle                                                            */
/* ---------------------------------------------------------------- */

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const control = (
    <button
      type="button"
      className="toggle"
      data-on={checked}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
    />
  );
  if (!label) return control;
  return (
    <div className="switch-row">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 550, fontSize: '0.9rem' }}>{label}</div>
        {hint && <div className="tiny faint">{hint}</div>}
      </div>
      {control}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Modal                                                             */
/* ---------------------------------------------------------------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, button, select')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' lg' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* ---------------------------------------------------------------- */
/* Misc                                                             */
/* ---------------------------------------------------------------- */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon: string; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="big">{icon}</span>
      <div style={{ fontWeight: 600, color: 'var(--text-dim)' }}>{title}</div>
      {hint && <div className="small">{hint}</div>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row" style={{ gap: 10, justifyContent: 'center', padding: 30 }}>
      <span className="spinner" />
      {label && <span className="muted small">{label}</span>}
    </div>
  );
}

export function Meter({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const cls = pct >= 95 ? 'meter full' : pct >= 80 ? 'meter warn' : 'meter';
  return (
    <div className={cls}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('done');
      return;
    } catch {
      // The Clipboard API needs a secure context, which plain http on a LAN
      // address is not. Fall back to a throwaway textarea.
    }
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    } finally {
      document.body.removeChild(ta);
    }
    // Never claim success we did not have - the point of the feedback is that
    // you can stop wondering whether the link is on your clipboard.
    setState(ok ? 'done' : 'failed');
  };

  const text = state === 'done' ? 'Copied!' : state === 'failed' ? 'Press Ctrl+C' : label;

  return (
    <button
      className="btn sm"
      onClick={copy}
      title={state === 'failed' ? 'Copying was blocked - select the link and copy it yourself' : label}
      data-copied={state === 'done' || undefined}
      style={state === 'done' ? { color: 'var(--success)', borderColor: 'var(--success)' } : undefined}
    >
      <Icon name={state === 'done' ? 'check' : 'copy'} size={13} />
      {text}
    </button>
  );
}
