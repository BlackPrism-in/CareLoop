'use client';
import Link from 'next/link';
import { useState } from 'react';
import { CaseTable } from '@/components/case-table';
import { Button, cx, LoadError, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useData } from '@/lib/use-data';

interface Overview {
  counts: {
    needApproval: number;
    handoffsPending: number;
    booked: number;
    proofToReview: number;
    mine: number;
  };
  asOf: string;
}

const TILES = [
  { key: 'needApproval', label: 'Need approval', href: '/intake' },
  { key: 'handoffsPending', label: 'Handoffs pending', href: '/handoffs' },
  { key: 'booked', label: 'Booked', href: '/cases?workflowState=BOOKED' },
  { key: 'proofToReview', label: 'Proof to review', href: '/cases?view=proof' },
] as const;

export default function OverviewPage() {
  const { data, error, loading, updatedAt, refresh } = useData<Overview>(
    () => api<Overview>('/v1/overview'),
    [],
    { pollMs: 30_000 },
  );
  const [scope, setScope] = useState<'me' | 'all'>('me');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Today&apos;s work</h1>
        <Link href="/cases/new">
          <Button variant="primary">+ New follow-up</Button>
        </Link>
      </div>

      {loading && !data ? (
        <Skeleton rows={2} />
      ) : error && !data ? (
        <LoadError message={error} onRetry={refresh} />
      ) : (
        data && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {TILES.map((t) => (
              <Link
                key={t.key}
                href={t.href}
                className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4 hover:bg-[var(--surface-2)]"
              >
                <div className="text-2xl font-semibold tabular-nums">{data.counts[t.key]}</div>
                <div className="text-sm text-[var(--muted)]">{t.label}</div>
              </Link>
            ))}
          </div>
        )
      )}
      {error && data && <LoadError message={error} onRetry={refresh} lastUpdated={updatedAt} />}

      <section className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        <div role="tablist" aria-label="Queue scope" className="mb-3 flex gap-1">
          {(
            [
              ['me', 'My queue'],
              ['all', 'All owners'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={scope === k}
              onClick={() => setScope(k)}
              className={cx(
                'rounded-md px-3 py-1.5 text-sm',
                scope === k ? 'bg-[var(--surface-2)] font-medium' : 'text-[var(--muted)]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <CaseTable
          query={scope === 'me' ? { owner: 'me' } : {}}
          empty={
            scope === 'me'
              ? 'No cases are assigned to you.'
              : 'No follow-ups yet. Create one with “New follow-up”.'
          }
        />
      </section>
      <p className="text-xs text-[var(--muted)]">
        “Past due date” refers to the approved operational deadline, not a medical risk.
      </p>
    </div>
  );
}
