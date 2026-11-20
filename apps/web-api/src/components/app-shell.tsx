'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useRequireStaff } from './auth-provider';
import { MfaEnroll } from './mfa-enroll';
import { Button, cx, Notice, Skeleton } from './ui';

const NAV = [
  { href: '/overview', label: 'Overview' },
  { href: '/cases', label: 'Cases' },
  { href: '/intake', label: 'Intake review' },
  { href: '/bookings', label: 'Bookings' },
  { href: '/handoffs', label: 'Human queue' },
  { href: '/reports', label: 'Reports' },
  { href: '/pilot', label: 'Pilot' },
  { href: '/settings', label: 'Settings' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { status, me, signOut } = useRequireStaff();
  const path = usePathname();

  if (status === 'loading' || status === 'signed-out') {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <Skeleton rows={4} />
      </div>
    );
  }
  if (status === 'mfa-enroll') return <MfaEnroll />;
  if (status === 'no-access') {
    return (
      <div className="mx-auto max-w-md p-6">
        <Notice tone="error">
          <p>This account isn't an active member of a lab in CareLoop.</p>
          <Button className="mt-2" onClick={signOut}>
            Sign out
          </Button>
        </Notice>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--line)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <Link href="/overview" className="font-semibold">
              CareLoop
            </Link>
            <span className="text-[var(--muted)]">/</span>
            <span>{me?.tenant?.displayName}</span>
            {me?.tenant?.simulation && (
              <span className="rounded border border-dashed border-[var(--line)] px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-[var(--muted)]">
                Synthetic demo data
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[var(--muted)]">
              {me?.displayName} · {me?.roles.map((r) => r.toLowerCase()).join(', ')}
            </span>
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
        <nav aria-label="Main" className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-2 pb-1">
          {NAV.map((n) => {
            const active = path === n.href || path.startsWith(`${n.href}/`);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'whitespace-nowrap rounded-md px-3 py-1.5 text-sm',
                  active
                    ? 'bg-[var(--surface-2)] font-medium'
                    : 'text-[var(--muted)] hover:text-[var(--fg)]',
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
