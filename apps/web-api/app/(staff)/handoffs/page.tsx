'use client';
import { useState } from 'react';
import { HandoffCard, type HandoffRow } from '@/components/handoff-card';
import { cx, LoadError, Notice, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useData } from '@/lib/use-data';

interface Resp {
  items: (HandoffRow & { ownerName: string; patientAlias: string; overdue: boolean })[];
  members: { uid: string; displayName: string }[];
}

export default function HandoffsPage() {
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const [toast, setToast] = useState<string | null>(null);
  const { data, error, loading, refresh, updatedAt } = useData<Resp>(
    () => api<Resp>(`/v1/handoffs?status=${tab}`),
    [tab],
    { pollMs: 10_000 },
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Human queue</h1>
        <p className="text-sm text-[var(--muted)]">
          Work that needs a named person. Acknowledging takes responsibility; resolving records what
          was done. Neither completes the follow-up. &ldquo;Past response deadline&rdquo; is an
          operational deadline, not a medical judgment, and this queue is not emergency cover.
        </p>
      </div>
      <div role="tablist" className="flex gap-1">
        {(['open', 'resolved'] as const).map((k) => (
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
            {k === 'open' ? 'Open' : 'Resolved'}
          </button>
        ))}
      </div>
      {toast && <Notice tone="ok">{toast}</Notice>}
      <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        {loading && !data ? (
          <Skeleton rows={3} />
        ) : error && !data ? (
          <LoadError message={error} onRetry={refresh} />
        ) : data?.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--muted)]">
            {tab === 'open' ? 'No handoffs are waiting.' : 'Nothing resolved yet.'}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {data?.items.map((h) => (
              <li key={h.handoffId} className="py-3">
                <HandoffCard
                  h={h}
                  members={data.members}
                  showCase
                  onChanged={(m) => {
                    setToast(m);
                    void refresh();
                  }}
                />
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
