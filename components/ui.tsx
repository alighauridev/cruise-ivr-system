import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'bad' | 'info' | 'ai';

export function PageHeader({
  title,
  subtitle,
  badge,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 px-10 pb-6 pt-9 max-lg:px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-[32px] font-medium leading-none tracking-tight text-ink">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="mt-2.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2.5">{actions}</div>}
    </header>
  );
}

export function Badge({ tone = 'neutral', dot, children, className = '' }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={`badge tone-${tone} ${className}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function AdminBadge() {
  return (
    <Badge tone="bad" className="!px-2 !py-0.5 text-[10px] font-semibold uppercase tracking-wider">
      Admin
    </Badge>
  );
}

/** Call status → tone, shared by the live panel and the history table. */
export const STATUS_TONE: Record<string, Tone> = {
  initiating: 'neutral',
  navigating_ivr: 'info',
  on_hold: 'warn',
  agent_detected: 'ok',
  ai_conversation: 'ai',
  transferring: 'ai',
  connected: 'ok',
  completed: 'neutral',
  failed: 'bad',
  cancelled: 'neutral',
};

/** Human label for a call status ("ai_conversation" → "AI conversation"). */
export function statusName(status: string): string {
  if (status === 'ai_conversation') return 'AI conversation';
  const s = status.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} dot>
      {statusName(status)}
    </Badge>
  );
}

export function Spinner({ className = 'h-6 w-6' }: { className?: string }) {
  return <span className={`${className} inline-block animate-spin rounded-full border-2 border-brand/25 border-t-brand`} />;
}

/** A pulsing dot for "something is live right now". */
export function LiveDot({ className = '' }: { className?: string }) {
  return (
    <span className={`relative inline-flex h-2.5 w-2.5 ${className}`}>
      <span className="pulse-ring absolute inset-0 rounded-full bg-ok" />
      <span className="relative h-2.5 w-2.5 rounded-full bg-ok" />
    </span>
  );
}

export function EmptyState({ icon, title, hint }: { icon: IconName; title: string; hint?: string }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-soft text-brand-strong">
        <Icon name={icon} className="h-7 w-7" strokeWidth={1.5} />
      </div>
      <p className="font-display text-lg text-ink">{title}</p>
      {hint && <p className="mt-1 max-w-xs text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-[3px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rise w-full max-w-md rounded-3xl border border-line bg-surface p-7 shadow-pop">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-xl text-ink">{title}</h2>
          <button type="button" onClick={onClose} className="btn-icon" aria-label="Close">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3.5">{children}</div>
        <div className="mt-6 flex gap-3">{footer}</div>
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-brand' : 'bg-line-strong'}`}
    >
      <span className={`inline-block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
    </button>
  );
}

/** A row of mutually-exclusive choices. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className = '',
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; hint?: string }>;
  className?: string;
}) {
  return (
    <div className={`grid gap-2 ${className}`} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded-xl border px-3.5 py-2.5 text-left transition ${
              on ? 'border-brand bg-brand-soft ring-4 ring-brand/10' : 'border-line-strong bg-surface hover:bg-sunken'
            }`}
          >
            <span className={`block text-sm font-semibold ${on ? 'text-brand-strong' : 'text-ink'}`}>{o.label}</span>
            {o.hint && <span className="mt-0.5 block text-xs text-muted">{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

const CHIP_TONE: Record<Tone, string> = {
  neutral: 'bg-sunken text-body',
  brand: 'bg-brand-soft text-brand-strong',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  ai: 'bg-ai-soft text-ai',
};

export function SectionCard({
  icon,
  tone = 'brand',
  title,
  description,
  children,
  className = '',
}: {
  icon: IconName;
  tone?: Tone;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card p-6 ${className}`}>
      <div className="mb-5 flex items-start gap-3.5">
        <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${CHIP_TONE[tone]}`}>
          <Icon name={icon} className="h-[18px] w-[18px]" />
        </span>
        <div>
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] leading-snug text-muted">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}
