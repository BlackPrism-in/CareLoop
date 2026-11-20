'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { WorkflowStatus } from '@/components/status';
import { Button, Card, Field, inputClass, LoadError, Notice, Skeleton } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { ACTION_LABEL, formatDate } from '@/lib/format';
import type { CaseDetail, CommandResult } from '@/lib/types';
import { useData } from '@/lib/use-data';

/**
 * Side-by-side review (MVP spec §07). The reviewer confirms each item
 * explicitly; the server re-checks everything and is the authority.
 */
export default function IntakeReview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { hasRole } = useAuth();
  const router = useRouter();
  const { data, error, loading, refresh } = useData<CaseDetail>(
    () => api<CaseDetail>(`/v1/cases/${encodeURIComponent(id)}`),
    [id],
  );
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [authorityRef, setAuthorityRef] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());

  if (loading && !data) return <Skeleton rows={6} />;
  if (error && !data) return <LoadError message={error} onRetry={refresh} />;
  if (!data) return null;
  const c = data.case;

  const adultOk = data.patient?.ageEligibility === 'ADULT_CONFIRMED';
  const consentOk = !!data.consent?.active;
  const rows: { key: string; label: string; value: string; source: string; blocked?: string }[] = [
    {
      key: 'patient',
      label: 'Patient reference',
      value: data.patient?.alias ?? '—',
      source: data.patient?.externalRef ?? '—',
    },
    {
      key: 'action',
      label: 'Action',
      value: `${ACTION_LABEL[c.actionType]} — ${c.actionText}`,
      source: data.source ? `${data.source.sourceAuthority} · ${data.source.reference}` : '—',
    },
    { key: 'dueAt', label: 'Due date', value: formatDate(c.dueAt), source: 'Entered on form' },
    {
      key: 'contact',
      label: 'Contact basis',
      value: consentOk
        ? `Permission ${data.consent?.noticeVersion} · ${data.consent?.channels.join(', ')}`
        : 'No active permission',
      source: data.consent?.consentId ?? '—',
      blocked: consentOk ? undefined : 'No active contact permission',
    },
    {
      key: 'owner',
      label: 'Accountable owner',
      value: data.owner?.displayName ?? c.ownerId,
      source: 'Entered on form',
    },
    {
      key: 'language',
      label: 'Language',
      value: c.language,
      source: `Patient preference: ${data.patient?.language ?? '—'}`,
    },
    {
      key: 'adult',
      label: 'Adult eligibility',
      value: adultOk ? 'Confirmed adult' : 'Not confirmed',
      source: 'Patient record',
      blocked: adultOk ? undefined : 'Adult eligibility not confirmed',
    },
  ];
  const blocked = rows.filter((r) => r.blocked).map((r) => r.blocked!);
  const allChecked = rows.every((r) => checked[r.key]);
  const canApprove = hasRole('REVIEWER') && c.workflowState === 'DRAFT';

  async function approve() {
    setBusy(true);
    setSubmitError(null);
    try {
      await api<CommandResult>(`/v1/cases/${c.caseId}/approve`, {
        method: 'POST',
        body: {
          expectedVersion: c.version,
          sourceAuthorityRef: authorityRef.trim(),
          checkedFields: rows.filter((r) => checked[r.key]).map((r) => r.key),
        },
        idempotencyKey: key,
      });
      router.push(`/cases/${c.caseId}`);
    } catch (e) {
      setSubmitError(describeError(e));
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-sm">
        <Link href="/intake" className="text-[var(--accent)] hover:underline">
          ← Intake review
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Review {c.caseId} before outreach</h1>
        <WorkflowStatus state={c.workflowState} />
      </div>
      {c.workflowState !== 'DRAFT' && (
        <Notice>This case is not a draft, so there is nothing to approve here.</Notice>
      )}

      <Card title="Approval checklist">
        <p className="mb-3 text-sm text-[var(--muted)]">
          Confirm each value against its source. Approval authorizes administrative follow-through
          only — clinical decisions stay upstream.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="py-2 pr-2 font-medium">Confirmed</th>
                <th className="py-2 pr-2 font-medium">Field</th>
                <th className="py-2 pr-2 font-medium">Value</th>
                <th className="py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-[var(--line)] last:border-0">
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      aria-label={`Confirm ${r.label}`}
                      disabled={!canApprove || !!r.blocked}
                      checked={!!checked[r.key]}
                      onChange={(e) => setChecked((s) => ({ ...s, [r.key]: e.target.checked }))}
                      className="h-4 w-4"
                    />
                  </td>
                  <td className="py-2 pr-2 font-medium">{r.label}</td>
                  <td className="py-2 pr-2">
                    {r.value}
                    {r.blocked && <div className="text-xs">⚠ {r.blocked}</div>}
                  </td>
                  <td className="py-2 text-[var(--muted)]">{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 max-w-md">
          <Field
            label="Upstream authority reference"
            hint="The clinician order or instruction this approval relies on, e.g. the order number."
          >
            <input
              className={inputClass}
              value={authorityRef}
              disabled={!canApprove}
              onChange={(e) => setAuthorityRef(e.target.value)}
              placeholder={data.source?.reference}
            />
          </Field>
        </div>
        <div className="mt-4 space-y-2">
          {blocked.length > 0 && (
            <Notice tone="warn">Approval blocked: {blocked.join('; ')}.</Notice>
          )}
          {!hasRole('REVIEWER') && <Notice>Only a reviewer can approve.</Notice>}
          {submitError && <Notice tone="error">{submitError}</Notice>}
          <Button
            variant="primary"
            onClick={approve}
            disabled={
              !canApprove || !allChecked || blocked.length > 0 || !authorityRef.trim() || busy
            }
          >
            {busy ? 'Approving…' : 'Approve for outreach'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
