'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { HandoffDoc } from '@careloop/domain';
import { useAuth } from './auth-provider';
import { Button, Field, inputClass, Notice } from './ui';
import { api, describeError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { reason } from '@/lib/labels';

export interface HandoffRow extends HandoffDoc {
  ownerName?: string;
  patientAlias?: string;
  caseVersion: number | null;
  overdue?: boolean;
}

/**
 * One handoff (MVP spec §18): a named owner acknowledges, then resolves with a
 * documented result. Neither step completes the follow-up itself.
 */
export function HandoffCard({
  h,
  members,
  showCase,
  onChanged,
}: {
  h: HandoffRow;
  members: { uid: string; displayName: string }[];
  showCase?: boolean;
  onChanged: (msg: string) => void;
}) {
  const { me, hasRole } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'none' | 'resolve' | 'reassign'>('none');
  const [resolution, setResolution] = useState('');
  const [resume, setResume] = useState(false);
  const [newOwner, setNewOwner] = useState('');
  const isOwner = me?.uid === h.ownerId;
  const canTakeOver = hasRole('OWNER', 'REVIEWER');
  const overdue = h.overdue ?? (h.status === 'PENDING' && Date.parse(h.dueAt) < Date.now());

  async function act(action: string, body: Record<string, unknown>, msg: string) {
    if (h.caseVersion === null) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/handoffs/${h.handoffId}/${action}`, {
        method: 'POST',
        body: { expectedVersion: h.caseVersion, ...body },
      });
      setMode('none');
      onChanged(msg);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {showCase && (
          <Link
            href={`/cases/${h.caseId}`}
            className="font-medium text-[var(--accent)] hover:underline"
          >
            {h.caseId}
          </Link>
        )}
        {showCase && <span className="text-[var(--muted)]">{h.patientAlias}</span>}
        <span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-xs">
          {h.status === 'PENDING'
            ? '⚑ Waiting for acknowledgment'
            : h.status === 'ACKNOWLEDGED'
              ? '◑ Acknowledged'
              : '✓ Resolved'}
        </span>
        {overdue && (
          <span className="rounded-full border border-[var(--err-line)] bg-[var(--err-bg)] px-2 py-0.5 text-xs">
            ! Past response deadline
          </span>
        )}
        {h.backupNotifiedAt && (
          <span className="text-xs text-[var(--muted)]">
            Backup notified {formatDateTime(h.backupNotifiedAt)}
          </span>
        )}
      </div>
      <div>
        <span className="font-medium">{reason(h.reasonCode)}</span>
        <span className="text-[var(--muted)]">
          {' '}
          · owner {h.ownerName ?? h.ownerId} · respond by {formatDateTime(h.dueAt)}
        </span>
      </div>
      {h.status !== 'RESOLVED' && (
        <div className="flex flex-wrap gap-2">
          {h.status === 'PENDING' && (isOwner || canTakeOver) && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => act('acknowledge', {}, 'Handoff acknowledged — it is yours now.')}
            >
              {isOwner ? 'Acknowledge' : 'Take it over'}
            </Button>
          )}
          {h.status === 'ACKNOWLEDGED' && (
            <Button onClick={() => setMode('resolve')}>Resolve…</Button>
          )}
          {canTakeOver && <Button onClick={() => setMode('reassign')}>Reassign…</Button>}
        </div>
      )}
      {mode === 'resolve' && (
        <div className="space-y-2 rounded-md border border-[var(--line)] p-3">
          <Field label="What was done">
            <input
              className={inputClass}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="e.g. Called patient; booked by phone for Monday"
            />
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />{' '}
            Let automated follow-up continue
          </label>
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={busy || !resolution.trim()}
              onClick={() =>
                act(
                  'resolve',
                  { resolution: resolution.trim(), resumeAutomation: resume },
                  'Handoff resolved. The follow-up stays open until its own evidence arrives.',
                )
              }
            >
              Resolve
            </Button>
            <Button onClick={() => setMode('none')}>Cancel</Button>
          </div>
        </div>
      )}
      {mode === 'reassign' && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-[var(--line)] p-3">
          <Field label="New owner">
            <select
              className={inputClass}
              value={newOwner}
              onChange={(e) => setNewOwner(e.target.value)}
            >
              <option value="">Select…</option>
              {members
                .filter((m) => m.uid !== h.ownerId)
                .map((m) => (
                  <option key={m.uid} value={m.uid}>
                    {m.displayName}
                  </option>
                ))}
            </select>
          </Field>
          <Button
            variant="primary"
            disabled={busy || !newOwner}
            onClick={() =>
              act('reassign', { ownerId: newOwner }, 'Reassigned. The new owner must acknowledge.')
            }
          >
            Reassign
          </Button>
          <Button onClick={() => setMode('none')}>Cancel</Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
