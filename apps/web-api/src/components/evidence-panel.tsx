'use client';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { Button, Card, cx, Field, inputClass, Notice, SimulationBadge } from './ui';
import { api, describeError } from '@/lib/api';
import { formatDateTime, isoToLocalInput, localInputToIso } from '@/lib/format';
import { reason } from '@/lib/labels';
import type { CaseDetail, EvidenceDoc } from '@/lib/types';

const STATUS: Record<EvidenceDoc['status'], { icon: string; label: string; tone: string }> = {
  VERIFIED: { icon: '✓', label: 'Verified', tone: 'border-[var(--ok-line)] bg-[var(--ok-bg)]' },
  CANDIDATE: {
    icon: '⧗',
    label: 'Needs a verifier',
    tone: 'border-[var(--warn-line)] bg-[var(--warn-bg)]',
  },
  CONFLICTED: {
    icon: '⚠',
    label: 'Conflict',
    tone: 'border-[var(--warn-line)] bg-[var(--warn-bg)]',
  },
  REJECTED: { icon: '✕', label: 'Rejected', tone: 'border-[var(--err-line)] bg-[var(--err-bg)]' },
  SELF_REPORTED: {
    icon: '○',
    label: 'Patient says it happened (not verified)',
    tone: 'border-[var(--line)]',
  },
};
const KIND: Record<EvidenceDoc['kind'], string> = {
  PROVIDER_EVENT: 'Calendar event',
  STAFF_RECORD: 'Staff record',
  SELF_REPORT: 'Self-report',
};

/** Evidence rules the UI can explain (MVP spec §18). There is no "Mark done" button. */
export function EvidencePanel({
  detail,
  simulation,
  onChanged,
}: {
  detail: CaseDetail;
  simulation: boolean;
  onChanged: (msg: string) => void;
}) {
  const c = detail.case;
  const { hasRole } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const open = !['DRAFT', 'CANCELLED', 'COMPLETED_VERIFIED'].includes(c.workflowState);

  async function run(path: string, body: unknown, done: string) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body });
      onChanged(done);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Completion evidence">
      <div className="space-y-3 text-sm">
        {c.workflowState === 'COMPLETED_VERIFIED' ? (
          <Notice tone="ok">Completed and verified from attributable evidence.</Notice>
        ) : (
          <p className="text-[var(--muted)]">
            A booking is not proof of completion. Only a matching signed event or a verifier&apos;s
            attestation completes this case.
          </p>
        )}
        {detail.evidence.length > 0 && (
          <ul className="space-y-2">
            {detail.evidence.map((e) => (
              <li key={e.evidenceId} className="rounded-md border border-[var(--line)] p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cx(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                      STATUS[e.status].tone,
                    )}
                  >
                    <span aria-hidden>{STATUS[e.status].icon}</span>
                    {STATUS[e.status].label}
                  </span>
                  <span>{KIND[e.kind]}</span>
                  <span className="text-[var(--muted)]">· {e.issuer}</span>
                  {e.simulation && <SimulationBadge />}
                </div>
                <div className="mt-1 text-xs text-[var(--muted)]">
                  {e.eventType === 'SAMPLE_COLLECTED' ? 'Sample collected' : 'Attended'}{' '}
                  {formatDateTime(e.occurredAt)} · source {e.sourceRef}
                </div>
                {e.reasons.length > 0 && e.status !== 'VERIFIED' && (
                  <div className="mt-1">Why: {e.reasons.map(reason).join('; ')}</div>
                )}
                {e.decisionReason && (
                  <div className="mt-1 text-xs">Decision: {reason(e.decisionReason)}</div>
                )}
                {e.aiReview && !('unavailable' in e.aiReview) && (
                  <div className="mt-1 text-xs text-[var(--muted)]">
                    AI review (advice only): {String(e.aiReview.summary ?? '')}
                  </div>
                )}
                {hasRole('VERIFIER') &&
                  open &&
                  ['CANDIDATE', 'CONFLICTED', 'SELF_REPORTED'].includes(e.status) && (
                    <Attest
                      evidence={e}
                      busy={busy}
                      onSubmit={(body) =>
                        run(
                          `/v1/evidence/${e.evidenceId}/attest`,
                          { expectedVersion: c.version, ...body },
                          body.decision === 'VERIFY' ? 'Attested.' : 'Rejected.',
                        )
                      }
                    />
                  )}
              </li>
            ))}
          </ul>
        )}

        {open && simulation && hasRole('COORDINATOR', 'VERIFIER') && c.approvalHash && (
          <div className="space-y-1.5 rounded-md border border-dashed border-[var(--line)] p-2.5">
            <p className="text-xs font-medium">
              Demo: send a signed sandbox-calendar event <SimulationBadge />
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  run(
                    `/v1/cases/${c.caseId}/simulate-provider-event`,
                    { scenario: 'WRONG_PATIENT' },
                    'Mismatched record sent.',
                  )
                }
              >
                Mismatched record
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  run(
                    `/v1/cases/${c.caseId}/simulate-provider-event`,
                    { scenario: 'WRONG_BOOKING' },
                    'Conflicting record sent.',
                  )
                }
              >
                Different booking
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  run(
                    `/v1/cases/${c.caseId}/simulate-provider-event`,
                    { scenario: 'MATCHING' },
                    'Matching attendance sent.',
                  )
                }
              >
                Matching attendance
              </Button>
            </div>
          </div>
        )}

        {open && c.approvalHash && hasRole('COORDINATOR', 'VERIFIER') && !recording && (
          <Button onClick={() => setRecording(true)}>Record evidence…</Button>
        )}
        {recording && (
          <RecordEvidence
            detail={detail}
            busy={busy}
            onCancel={() => setRecording(false)}
            onSubmit={async (body) => {
              await run(
                `/v1/cases/${c.caseId}/evidence`,
                { expectedVersion: c.version, ...body },
                body.kind === 'SELF_REPORT'
                  ? 'Self-report recorded (not counted as verified).'
                  : 'Evidence recorded; a verifier must attest.',
              );
              setRecording(false);
            }}
          />
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}

function Attest({
  evidence,
  busy,
  onSubmit,
}: {
  evidence: EvidenceDoc;
  busy: boolean;
  onSubmit: (b: { decision: 'VERIFY' | 'REJECT'; reason: string; sourceRef: string }) => void;
}) {
  const [why, setWhy] = useState('');
  const [source, setSource] = useState(evidence.kind === 'SELF_REPORT' ? '' : evidence.sourceRef);
  const canVerify = evidence.kind !== 'SELF_REPORT';
  return (
    <div className="mt-2 grid gap-2 border-t border-[var(--line)] pt-2 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
      <Field label="Reason">
        <input
          className={inputClass}
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          placeholder="e.g. Seen in clinic register"
        />
      </Field>
      <Field label="Source you checked">
        <input
          className={inputClass}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={!canVerify}
        />
      </Field>
      <Button
        variant="primary"
        disabled={busy || !canVerify || !why.trim() || !source.trim()}
        onClick={() =>
          onSubmit({ decision: 'VERIFY', reason: why.trim(), sourceRef: source.trim() })
        }
        title={
          canVerify
            ? ''
            : 'A patient statement cannot be verified; record independent evidence instead.'
        }
      >
        Verify
      </Button>
      <Button
        disabled={busy || !why.trim()}
        onClick={() => onSubmit({ decision: 'REJECT', reason: why.trim(), sourceRef: '' })}
      >
        Reject
      </Button>
      {!canVerify && (
        <p className="text-xs text-[var(--muted)] md:col-span-4">
          A patient&apos;s own statement can&apos;t be verified. Record independent evidence
          instead.
        </p>
      )}
    </div>
  );
}

function RecordEvidence({
  detail,
  busy,
  onSubmit,
  onCancel,
}: {
  detail: CaseDetail;
  busy: boolean;
  onSubmit: (b: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const c = detail.case;
  const [kind, setKind] = useState<'STAFF_RECORD' | 'SELF_REPORT'>('STAFF_RECORD');
  const [issuer, setIssuer] = useState('');
  const [when, setWhen] = useState(isoToLocalInput(c.bookedStartsAt ?? new Date().toISOString()));
  const [source, setSource] = useState('');
  const [excerpt, setExcerpt] = useState('');
  return (
    <div className="space-y-2 rounded-md border border-[var(--line)] p-3">
      <div className="flex gap-3">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={kind === 'STAFF_RECORD'}
            onChange={() => setKind('STAFF_RECORD')}
          />{' '}
          Record from the clinic/lab
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={kind === 'SELF_REPORT'}
            onChange={() => {
              setKind('SELF_REPORT');
              setIssuer('patient');
            }}
          />{' '}
          Patient says it happened
        </label>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <Field label="Issued by">
          <input
            className={inputClass}
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            placeholder="e.g. Demo Clinic register"
          />
        </Field>
        <Field label="When it happened (IST)">
          <input
            className={inputClass}
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </Field>
        <Field label="Source reference">
          <input
            className={inputClass}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="e.g. register page 14"
          />
        </Field>
      </div>
      {kind === 'STAFF_RECORD' && (
        <Field
          label="Administrative excerpt (optional)"
          hint="An attendance or collection line only — no results. An AI review is shown to the verifier as advice."
        >
          <textarea
            className={`${inputClass} min-h-16`}
            maxLength={2000}
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
          />
        </Field>
      )}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={busy || !issuer.trim() || !source.trim() || !when}
          onClick={() =>
            onSubmit({
              kind,
              issuer: issuer.trim(),
              eventType:
                c.actionType === 'ORDERED_TEST' ? 'SAMPLE_COLLECTED' : 'APPOINTMENT_ATTENDED',
              occurredAt: localInputToIso(when),
              sourceRef: source.trim(),
              ...(excerpt.trim() ? { excerpt: excerpt.trim() } : {}),
            })
          }
        >
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
