'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { CaseListItem } from '@careloop/domain';
import { api, describeError } from '@/lib/api';
import { ACTION_LABEL, formatDate, isOverdue } from '@/lib/format';
import { useData } from '@/lib/use-data';
import { HandoffBadge, OverdueBadge, PausedBadge, WorkflowStatus } from './status';
import { Button, LoadError, Notice, Skeleton } from './ui';

interface Page {
  items: CaseListItem[];
  nextCursor: string | null;
}

/** Paginated case list. Rows show an alias, never full patient identifiers. */
export function CaseTable({
  query,
  empty,
  hrefFor,
}: {
  query: Record<string, string>;
  empty: string;
  hrefFor?: (c: CaseListItem) => string;
}) {
  const qs = new URLSearchParams(query).toString();
  const { data, error, loading, updatedAt, refresh, setData } = useData<Page>(
    () => api<Page>(`/v1/cases?${qs}`),
    [qs],
  );
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  async function more() {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await api<Page>(`/v1/cases?${qs}&cursor=${encodeURIComponent(data.nextCursor)}`);
      setData({ items: [...data.items, ...next.items], nextCursor: next.nextCursor });
      setMoreError(null);
    } catch (e) {
      setMoreError(describeError(e));
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading && !data) return <Skeleton rows={4} />;
  if (error && !data) return <LoadError message={error} onRetry={refresh} />;
  if (!data) return null;
  if (data.items.length === 0)
    return <p className="py-6 text-center text-sm text-[var(--muted)]">{empty}</p>;

  return (
    <div>
      {error && <LoadError message={error} onRetry={refresh} lastUpdated={updatedAt} />}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
              <th className="py-2 pr-3 font-medium">Case</th>
              <th className="py-2 pr-3 font-medium">Action</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 font-medium">Due</th>
              <th className="py-2 font-medium">Owner</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((c) => (
              <tr
                key={c.caseId}
                className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--surface-2)]"
              >
                <td className="py-2.5 pr-3">
                  <Link
                    href={hrefFor ? hrefFor(c) : `/cases/${c.caseId}`}
                    className="font-medium text-[var(--accent)] hover:underline"
                  >
                    {c.caseId}
                  </Link>
                  <div className="text-xs text-[var(--muted)]">{c.patientAlias}</div>
                </td>
                <td className="py-2.5 pr-3">{ACTION_LABEL[c.actionType]}</td>
                <td className="py-2.5 pr-3">
                  <div className="flex flex-wrap gap-1">
                    <WorkflowStatus state={c.workflowState} />
                    <HandoffBadge state={c.handoffState} />
                    {c.workflowState !== 'DRAFT' && (
                      <PausedBadge reason={c.automationPausedReason} />
                    )}
                  </div>
                </td>
                <td className="py-2.5 pr-3">
                  <div className="flex flex-wrap items-center gap-1">
                    {formatDate(c.dueAt)}
                    {isOverdue(c.dueAt, c.workflowState) && <OverdueBadge />}
                  </div>
                </td>
                <td className="py-2.5">{c.ownerName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {moreError && <Notice tone="error">{moreError}</Notice>}
      {data.nextCursor && (
        <div className="mt-3 text-center">
          <Button onClick={more} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      <p className="mt-3 text-right text-xs text-[var(--muted)]">Last updated {updatedAt}</p>
    </div>
  );
}
