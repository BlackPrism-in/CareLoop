'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Button, Card, LoadError, Notice, Skeleton } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { FailedJobDoc } from '@/lib/types';
import { useData } from '@/lib/use-data';

export default function SettingsPage() {
  const { hasRole } = useAuth();
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      {hasRole('OWNER', 'COORDINATOR', 'AUDITOR') ? (
        <FailedJobs canReplay={hasRole('OWNER')} />
      ) : (
        <Notice>Nothing to configure for your role yet.</Notice>
      )}
      <p className="text-sm text-[var(--muted)]">
        Staff roles, contact policy, approved logistics and integrations arrive with pilot
        hardening.
      </p>
    </div>
  );
}

/** Recovery dashboard (MVP spec §16): work that stopped retrying and needs a person. */
function FailedJobs({ canReplay }: { canReplay: boolean }) {
  const { data, error, loading, refresh } = useData<{ items: FailedJobDoc[] }>(
    () => api('/v1/jobs/failed'),
    [],
  );
  const [msg, setMsg] = useState<string | null>(null);

  async function replay(id: string) {
    try {
      await api(`/v1/jobs/${id}/replay`, { method: 'POST', body: {} });
      setMsg('Replayed with the original operation id.');
      void refresh();
    } catch (e) {
      setMsg(describeError(e));
    }
  }

  return (
    <Card title="Failed background jobs">
      {loading && !data ? (
        <Skeleton rows={2} />
      ) : error && !data ? (
        <LoadError message={error} onRetry={refresh} />
      ) : data && data.items.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No failed jobs.</p>
      ) : (
        <ul className="divide-y divide-[var(--line)] text-sm">
          {data?.items.map((j) => (
            <li key={j.jobId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <span className="font-medium">{j.kind.toLowerCase().replaceAll('_', ' ')}</span> ·{' '}
                <Link className="text-[var(--accent)] hover:underline" href={`/cases/${j.caseId}`}>
                  {j.caseId}
                </Link>
                <div className="text-xs text-[var(--muted)]">
                  {j.reason} · {j.attempts} attempts · {formatDateTime(j.failedAt)}
                </div>
              </div>
              {canReplay && <Button onClick={() => replay(j.jobId)}>Replay</Button>}
            </li>
          ))}
        </ul>
      )}
      {msg && (
        <div className="mt-2">
          <Notice>{msg}</Notice>
        </div>
      )}
    </Card>
  );
}
