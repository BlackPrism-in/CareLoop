'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { BillingCard } from '@/components/billing-card';
import { SitesAdmin } from '@/components/sites-admin';
import { Button, Card, Field, inputClass, LoadError, Notice, Skeleton } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { FailedJobDoc } from '@/lib/types';
import { useData } from '@/lib/use-data';

export default function SettingsPage() {
  const { hasRole } = useAuth();
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      {hasRole('OWNER', 'AUDITOR') && <Operations />}
      {hasRole('OWNER') && <Usage />}
      {hasRole('OWNER') && <SitesAdmin />}
      {hasRole('OWNER') && <BillingCard />}
      {hasRole('OWNER', 'COORDINATOR', 'AUDITOR') ? (
        <FailedJobs canReplay={hasRole('OWNER')} />
      ) : (
        <Notice>Nothing to configure for your role yet.</Notice>
      )}
      {hasRole('OWNER') && <Erasure />}
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

interface UsageResp {
  tenant: { limits: { monthlyContactAttempts: number; monthlyVoiceSeconds: number } | null } | null;
  usage?: { month: string; contactAttempts: number; voiceSeconds: number };
}

/** Contracted monthly allowance vs use. Contact stops automatically at the limit. */
function Usage() {
  const { data } = useData<UsageResp>(() => api('/v1/me/outreach'), []);
  if (!data?.usage) return null;
  const l = data.tenant?.limits;
  const row = (label: string, used: number, limit: number | undefined, unit = '') => (
    <li>
      {label}:{' '}
      <span className="tabular-nums">
        {used}
        {unit}
      </span>
      {limit ? (
        <span className="text-[var(--muted)]">
          {' '}
          of {limit}
          {unit}
          {used >= limit ? ' — limit reached, contact is paused' : ''}
        </span>
      ) : (
        <span className="text-[var(--muted)]"> (no limit set)</span>
      )}
    </li>
  );
  return (
    <Card title={`Usage this month (${data.usage.month})`}>
      <ul className="space-y-1 text-sm">
        {row('Contact attempts', data.usage.contactAttempts, l?.monthlyContactAttempts)}
        {row(
          'Billed voice',
          Math.round(data.usage.voiceSeconds / 60),
          l ? Math.round(l.monthlyVoiceSeconds / 60) : undefined,
          ' min',
        )}
      </ul>
    </Card>
  );
}

/** Patient erasure request (owner only). Refused while any follow-up is open. */
function Erasure() {
  const [patientId, setPatientId] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  async function submit() {
    try {
      const r = await api<{ casesKept: number }>(
        `/v1/patients/${encodeURIComponent(patientId.trim())}/erasure`,
        { method: 'POST', body: { reason: reason.trim() } },
      );
      setMsg({
        tone: 'ok',
        text: `Erased. Identifiers and contact details removed; ${r.casesKept} case record(s) kept without them, under the retention schedule.`,
      });
      setConfirm(false);
    } catch (e) {
      setMsg({ tone: 'error', text: describeError(e) });
    }
  }
  return (
    <Card title="Patient data requests">
      <div className="space-y-2 text-sm">
        <p className="text-[var(--muted)]">
          Erase a patient&apos;s identifiers and contact details. Not possible while they have an
          open follow-up. Backups expire on their own schedule.
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <Field label="Patient ID">
            <input
              className={inputClass}
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            />
          </Field>
          <Field label="Reason / request reference">
            <input
              className={inputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </div>
        {!confirm ? (
          <Button disabled={!patientId.trim() || !reason.trim()} onClick={() => setConfirm(true)}>
            Erase patient data…
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="primary" onClick={submit}>
              Confirm erasure — cannot be undone
            </Button>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        )}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
    </Card>
  );
}

interface Ops {
  asOf: string;
  oldestPendingWorkSeconds: number;
  failedJobs: number;
  bookingsOutcomeUnknown: number;
  handoffsWaiting: number;
  handoffsOverdue: number;
  calls24h: { total: number; failedToConnect: number; disconnected: number; flaggedClaims: number };
}

/** What needs attention right now (MVP spec §20). Platform alerts go to the named operator. */
function Operations() {
  const { data, error, refresh } = useData<Ops>(() => api('/v1/ops/metrics'), [], {
    pollMs: 30_000,
  });
  if (error && !data) return <LoadError message={error} onRetry={refresh} />;
  if (!data) return null;
  const warn = (bad: boolean, text: string) => (
    <li className={bad ? 'font-medium' : ''}>
      {bad ? '⚠ ' : ''}
      {text}
    </li>
  );
  return (
    <Card title="Operations">
      <ul className="grid gap-1 text-sm md:grid-cols-2">
        {warn(
          data.oldestPendingWorkSeconds > 300,
          `Oldest queued work: ${data.oldestPendingWorkSeconds}s`,
        )}
        {warn(data.failedJobs > 0, `Failed background jobs: ${data.failedJobs}`)}
        {warn(
          data.bookingsOutcomeUnknown > 0,
          `Bookings with unknown outcome: ${data.bookingsOutcomeUnknown}`,
        )}
        {warn(
          data.handoffsOverdue > 0,
          `Handoffs waiting: ${data.handoffsWaiting} (${data.handoffsOverdue} overdue)`,
        )}
        {warn(
          data.calls24h.failedToConnect > 0,
          `Calls (24 h): ${data.calls24h.total} · failed to connect ${data.calls24h.failedToConnect} · dropped ${data.calls24h.disconnected}`,
        )}
        {warn(
          data.calls24h.flaggedClaims > 0,
          `Calls flagged for review (premature "booked"): ${data.calls24h.flaggedClaims}`,
        )}
      </ul>
    </Card>
  );
}
