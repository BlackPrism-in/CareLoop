'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { HandoffBadge, OverdueBadge, PausedBadge, WorkflowStatus } from '@/components/status';
import { BookingPanel } from '@/components/booking-panel';
import { Timeline } from '@/components/timeline';
import { Button, Card, Field, inputClass, LoadError, Notice, Skeleton } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import {
  ACTION_LABEL,
  formatDate,
  formatDateTime,
  isOverdue,
  isoToLocalInput,
  localInputToIso,
} from '@/lib/format';
import type { CaseDetail, CommandResult, Lookups } from '@/lib/types';
import { useData } from '@/lib/use-data';

const OUTREACH: Record<string, string> = {
  NOT_STARTED: 'Not started',
  RETRY_SCHEDULED: 'Retry scheduled',
  REACHED: 'Reached',
  DECLINED: 'Declined',
  OPTED_OUT: 'Opted out',
  UNREACHABLE: 'Unreachable',
};

export default function CaseWorkspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { hasRole } = useAuth();
  const { data, error, loading, updatedAt, refresh } = useData<CaseDetail>(
    () => api<CaseDetail>(`/v1/cases/${encodeURIComponent(id)}`),
    [id],
    { pollMs: 5000 },
  );
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  if (loading && !data) return <Skeleton rows={6} />;
  if (error && !data) return <LoadError message={error} onRetry={refresh} />;
  if (!data) return null;
  const c = data.case;
  const names = new Map<string, string>(Object.entries(data.actors));
  const canEdit =
    hasRole('COORDINATOR', 'REVIEWER') &&
    ['DRAFT', 'READY', 'CONTACTING', 'AWAITING_BOOKING'].includes(c.workflowState);

  return (
    <div className="space-y-4">
      <div className="text-sm">
        <Link href="/cases" className="text-[var(--accent)] hover:underline">
          ← Cases
        </Link>
      </div>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{c.caseId}</h1>
          <span className="text-[var(--muted)]">
            {data.patient?.alias ?? 'Unknown patient'} / {ACTION_LABEL[c.actionType]} follow-up
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <WorkflowStatus state={c.workflowState} />
          <HandoffBadge state={c.handoffState} />
          <PausedBadge reason={c.automationPausedReason} />
          {isOverdue(c.dueAt, c.workflowState) && <OverdueBadge />}
          <span className="text-[var(--muted)]">Outreach: {OUTREACH[c.outreachDisposition]}</span>
          <span className="text-[var(--muted)]">
            · Owner: {data.owner?.displayName ?? c.ownerId}
          </span>
        </div>
      </header>

      {toast && <Notice tone="ok">{toast}</Notice>}
      {error && <LoadError message={error} onRetry={refresh} lastUpdated={updatedAt} />}

      <div className="flex flex-wrap gap-2">
        {c.workflowState === 'DRAFT' && hasRole('REVIEWER') && (
          <Link href={`/intake/${c.caseId}`}>
            <Button variant="primary">Review and approve</Button>
          </Link>
        )}
        {c.workflowState === 'DRAFT' && !hasRole('REVIEWER') && (
          <Notice>Waiting for a reviewer to approve this draft.</Notice>
        )}
        {canEdit && !editing && <Button onClick={() => setEditing(true)}>Edit draft</Button>}
      </div>

      {editing && (
        <EditDraft
          detail={data}
          onDone={(r) => {
            setEditing(false);
            setToast(
              r
                ? r.eventType === 'CASE_EDITED_APPROVAL_INVALIDATED'
                  ? 'Saved. Approval was invalidated and the case is back in review.'
                  : 'Saved.'
                : null,
            );
            void refresh();
          }}
        />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Approved action">
          <dl className="space-y-1.5 text-sm">
            <Row k="Instruction">{c.actionText}</Row>
            <Row k="Approval">
              {c.approvalHash
                ? `Approved · revision ${c.approvalRevision} · ${formatDateTime(c.approvedAt)}`
                : c.approvalRevision > 0
                  ? `Revision ${c.approvalRevision} invalidated by an edit`
                  : 'Not approved'}
            </Row>
            <Row k="Due">{formatDate(c.dueAt)}</Row>
            <Row k="Source">
              {data.source
                ? `${data.source.sourceAuthority} · ${data.source.reference}`
                : c.sourceId}
            </Row>
            <Row k="Language">{c.language}</Row>
            <Row k="Contact">
              {data.consent?.active
                ? `Permitted · ${data.consent.channels.join(', ').toLowerCase().replaceAll('_', ' ')}`
                : 'No active permission'}
            </Row>
            {hasRole('OWNER', 'REVIEWER', 'COORDINATOR') && data.patient && (
              <Row k="Patient contact">{data.patient.contactMasked}</Row>
            )}
          </dl>
        </Card>
        <BookingPanel
          detail={data}
          onChanged={(msg) => {
            setToast(msg);
            void refresh();
          }}
        />
        <Card title="Activity timeline">
          <Timeline events={data.events} names={names} />
        </Card>
        <Card title="Completion evidence">
          {c.evidenceState === 'VERIFIED' ? (
            <Notice tone="ok">Completion verified from attributable evidence.</Notice>
          ) : (
            <>
              <p className="text-sm">
                {c.evidenceState === 'SELF_REPORTED'
                  ? 'Patient says it happened. Not yet verified.'
                  : 'No verified attendance received.'}
              </p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                A booking is not proof of completion.
              </p>
            </>
          )}
        </Card>
      </div>
      <p className="text-right text-xs text-[var(--muted)]">
        Refreshes every 5 s · last updated {updatedAt}
      </p>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2">
      <dt className="text-[var(--muted)]">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function EditDraft({
  detail,
  onDone,
}: {
  detail: CaseDetail;
  onDone: (r: CommandResult | null) => void;
}) {
  const c = detail.case;
  const { data: lookups } = useData<Lookups>(() => api<Lookups>('/v1/lookups'), []);
  const [actionText, setActionText] = useState(c.actionText);
  const [due, setDue] = useState(isoToLocalInput(c.dueAt));
  const [ownerId, setOwnerId] = useState(c.ownerId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());

  async function save() {
    const edit: Record<string, string> = {};
    if (actionText.trim() !== c.actionText) edit.actionText = actionText.trim();
    if (localInputToIso(due) !== c.dueAt) edit.dueAt = localInputToIso(due);
    if (ownerId !== c.ownerId) edit.ownerId = ownerId;
    if (Object.keys(edit).length === 0) return onDone(null);
    setBusy(true);
    try {
      onDone(
        await api<CommandResult>(`/v1/cases/${c.caseId}/draft`, {
          method: 'PATCH',
          body: { expectedVersion: c.version, edit },
          idempotencyKey: key,
        }),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Edit draft">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Instruction">
          <input
            className={inputClass}
            value={actionText}
            onChange={(e) => setActionText(e.target.value)}
          />
        </Field>
        <Field label="Due (IST)">
          <input
            className={inputClass}
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </Field>
        <Field label="Owner">
          <select
            className={inputClass}
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
          >
            {lookups?.members.map((m) => (
              <option key={m.uid} value={m.uid}>
                {m.displayName}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {c.approvalHash && (
        <div className="mt-3">
          <Notice tone="warn">
            Changing the instruction or due date invalidates the current approval. The case returns
            to review and automation pauses.
          </Notice>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button onClick={() => onDone(null)}>Cancel</Button>
      </div>
    </Card>
  );
}
