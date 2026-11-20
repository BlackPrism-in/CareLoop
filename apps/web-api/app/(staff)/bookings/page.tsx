'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import {
  Button,
  cx,
  Field,
  inputClass,
  LoadError,
  Notice,
  SimulationBadge,
  Skeleton,
} from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { formatDateTime, localInputToIso } from '@/lib/format';
import type { BookingRow, CaseDetail, CommandResult } from '@/lib/types';
import { useData } from '@/lib/use-data';

const TABS = [
  ['open', 'Needs attention'],
  ['confirmed', 'Confirmed'],
  ['closed', 'Closed'],
] as const;

const STATUS: Record<string, string> = {
  REQUESTED: '⧗ Request sent',
  PENDING_STAFF: '⚑ Staff to book',
  UNKNOWN: '? Outcome unknown',
  CANCEL_PENDING: '⧗ Cancellation pending',
  CONFIRMED: '▣ Confirmed',
  REJECTED: '⊘ Not possible',
  CANCELLED: '⊘ Cancelled',
};

export default function BookingsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('open');
  const { data, error, loading, refresh, updatedAt } = useData<{ items: BookingRow[] }>(
    () => api(`/v1/bookings?status=${tab}`),
    [tab],
    { pollMs: 10_000 },
  );
  const { hasRole } = useAuth();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Bookings</h1>
        <p className="text-sm text-[var(--muted)]">
          Booking requests and appointments. A booking is a milestone, not proof that the follow-up
          happened.
        </p>
      </div>
      <div role="tablist" className="flex gap-1">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cx(
              'rounded-md px-3 py-1.5 text-sm',
              tab === k ? 'bg-[var(--surface-2)] font-medium' : 'text-[var(--muted)]',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        {loading && !data ? (
          <Skeleton rows={3} />
        ) : error && !data ? (
          <LoadError message={error} onRetry={refresh} />
        ) : data && data.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--muted)]">Nothing here.</p>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {data?.items.map((b) => (
              <li key={b.bookingId} className="space-y-2 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/cases/${b.caseId}`}
                    className="font-medium text-[var(--accent)] hover:underline"
                  >
                    {b.caseId}
                  </Link>
                  <span className="text-[var(--muted)]">{b.patientAlias}</span>
                  <span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-xs">
                    {STATUS[b.status]}
                  </span>
                  {b.simulation && <SimulationBadge />}
                  {b.adapter === 'manual' && (
                    <span className="text-xs text-[var(--muted)]">manual</span>
                  )}
                </div>
                <div className="text-[var(--muted)]">
                  {b.startsAt
                    ? `${formatDateTime(b.startsAt)} · ${b.location ?? ''}`
                    : `Requested ${formatDateTime(b.createdAt)}`}
                  {b.externalRef && ` · ${b.externalRef}`}
                  {b.reason && ` · ${b.reason.toLowerCase().replaceAll('_', ' ')}`}
                </div>
                {b.status === 'PENDING_STAFF' && hasRole('COORDINATOR') && (
                  <ManualConfirm booking={b} onDone={refresh} />
                )}
              </li>
            ))}
          </ul>
        )}
        {updatedAt && (
          <p className="mt-2 text-right text-xs text-[var(--muted)]">Last updated {updatedAt}</p>
        )}
      </div>
    </div>
  );
}

function ManualConfirm({ booking, onDone }: { booking: BookingRow; onDone: () => void }) {
  const [ref, setRef] = useState('');
  const [when, setWhen] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const detail = await api<CaseDetail>(`/v1/cases/${booking.caseId}`);
      await api<CommandResult>(`/v1/bookings/${booking.bookingId}/confirm-manual`, {
        method: 'POST',
        idempotencyKey: key,
        body: {
          expectedVersion: detail.case.version,
          externalRef: ref.trim(),
          startsAt: localInputToIso(when),
        },
      });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-md border border-[var(--line)] p-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
      <Field label="Clinic's booking reference">
        <input className={inputClass} value={ref} onChange={(e) => setRef(e.target.value)} />
      </Field>
      <Field label="Confirmed time (IST)">
        <input
          className={inputClass}
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
      </Field>
      <Button variant="primary" disabled={!ref.trim() || !when || busy} onClick={save}>
        Record booking
      </Button>
      {error && (
        <div className="md:col-span-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </div>
  );
}
