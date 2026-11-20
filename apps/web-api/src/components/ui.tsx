import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function Button({
  variant = 'secondary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' &&
          'bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-strong)]',
        variant === 'secondary' &&
          'border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-2)]',
        variant === 'ghost' && 'hover:bg-[var(--surface-2)]',
        className,
      )}
    />
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx('rounded-lg border border-[var(--line)] bg-[var(--surface)]', className)}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--muted)]">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-[var(--accent)]';

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  children: ReactNode;
}) {
  const icon = { info: 'ℹ', warn: '⚠', error: '✕', ok: '✓' }[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'flex gap-2 rounded-md border px-3 py-2 text-sm',
        tone === 'info' && 'border-[var(--line)] bg-[var(--surface-2)]',
        tone === 'warn' && 'border-[var(--warn-line)] bg-[var(--warn-bg)]',
        tone === 'error' && 'border-[var(--err-line)] bg-[var(--err-bg)]',
        tone === 'ok' && 'border-[var(--ok-line)] bg-[var(--ok-bg)]',
      )}
    >
      <span aria-hidden>{icon}</span>
      <div>{children}</div>
    </div>
  );
}

export function SimulationBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-dashed border-[var(--line)] px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-[var(--muted)]">
      ◌ Simulated
    </span>
  );
}

export function LoadError({
  message,
  onRetry,
  lastUpdated,
}: {
  message: string;
  onRetry: () => void;
  lastUpdated?: string | null;
}) {
  return (
    <Notice tone="error">
      <p>{message}</p>
      {lastUpdated && (
        <p className="text-xs text-[var(--muted)]">
          Last updated {lastUpdated}. Counts are not shown as zero.
        </p>
      )}
      <Button className="mt-2" onClick={onRetry}>
        Retry
      </Button>
    </Notice>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-[var(--surface-2)]" />
      ))}
    </div>
  );
}
