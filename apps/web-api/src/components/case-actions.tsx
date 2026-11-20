'use client';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { ExportButton } from './export-button';
import { Button, Field, inputClass, Notice } from './ui';
import { api, describeError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { CaseDetail } from '@/lib/types';

type Mode = 'none' | 'cancel' | 'reopen' | 'revoke' | 'link';

/** Less frequent, consequential actions — each needs a reason and is audited in the timeline. */
export function CaseActions({
  detail,
  onChanged,
}: {
  detail: CaseDetail;
  onChanged: (msg: string) => void;
}) {
  const c = detail.case;
  const { hasRole } = useAuth();
  const [mode, setMode] = useState<Mode>('none');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{
    url: string;
    code: string;
    expiresAt: string;
    delivery: string;
  } | null>(null);
  const open = !['CANCELLED', 'COMPLETED_VERIFIED'].includes(c.workflowState);

  async function submit(path: string, body: unknown, msg: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Record<string, unknown>>(path, { method: 'POST', body });
      if (mode === 'link') setLink(r as never);
      else {
        setMode('none');
        setWhy('');
      }
      onChanged(msg);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const buttons = [
    open &&
      c.workflowState !== 'DRAFT' &&
      hasRole('COORDINATOR') &&
      (['link', 'Patient link…'] as const),
    open &&
      detail.consent?.active &&
      hasRole('COORDINATOR', 'REVIEWER', 'OWNER') &&
      (['revoke', 'Patient withdrew permission…'] as const),
    open && hasRole('REVIEWER', 'OWNER') && (['cancel', 'Cancel follow-up…'] as const),
    !open && hasRole('REVIEWER', 'VERIFIER', 'OWNER') && (['reopen', 'Reopen…'] as const),
  ].filter(Boolean) as (readonly [Mode, string])[];
  if (buttons.length === 0 && !hasRole('OWNER', 'AUDITOR')) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {buttons.map(([m, label]) => (
          <Button
            key={m}
            variant="ghost"
            onClick={() => {
              setMode(m);
              setError(null);
              setLink(null);
            }}
          >
            {label}
          </Button>
        ))}
        <ExportButton caseId={c.caseId} />
      </div>
      {mode === 'link' && (
        <div className="space-y-2 rounded-md border border-[var(--line)] p-3 text-sm">
          {!link ? (
            <>
              <p>
                Creates a private link and a separate 6-digit code for the patient. They can see
                their request status and ask for a change, ask for a call, or stop automated
                contact. No medical details are shown.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    submit(`/v1/cases/${c.caseId}/patient-links`, {}, 'Patient link created.')
                  }
                >
                  Create link
                </Button>
                <Button onClick={() => setMode('none')}>Close</Button>
              </div>
            </>
          ) : (
            <>
              <Notice tone="warn">
                Shown once.{' '}
                {link.delivery === 'SIMULATED_NOT_SENT'
                  ? 'Synthetic lab: nothing was sent. In a pilot the link and code go by separate approved messages.'
                  : 'Send the link and the code separately.'}
              </Notice>
              <div className="break-all font-mono text-xs">{link.url}</div>
              <div>
                Code:{' '}
                <span className="font-mono text-base font-semibold tracking-widest">
                  {link.code}
                </span>{' '}
                · expires {formatDateTime(link.expiresAt)}
              </div>
              <Button
                onClick={() => {
                  setMode('none');
                  setLink(null);
                }}
              >
                Done
              </Button>
            </>
          )}
        </div>
      )}
      {(mode === 'cancel' || mode === 'reopen' || mode === 'revoke') && (
        <div className="space-y-2 rounded-md border border-[var(--line)] p-3 text-sm">
          {mode === 'cancel' && (
            <p>
              Withdraws the obligation itself (for example the clinic withdrew the order). Opting
              out is not a cancellation.
            </p>
          )}
          {mode === 'revoke' && (
            <p>
              Stops all automated contact for this patient immediately. The follow-up stays open for
              staff.
            </p>
          )}
          {mode === 'reopen' && <p>Corrects a closed case. Its history and evidence are kept.</p>}
          <Field label="Reason">
            <input className={inputClass} value={why} onChange={(e) => setWhy(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={busy || !why.trim()}
              onClick={() =>
                mode === 'revoke'
                  ? submit(
                      `/v1/consents/${c.consentId}/revoke`,
                      { reason: why.trim() },
                      'Permission withdrawn — automated contact stopped.',
                    )
                  : submit(
                      `/v1/cases/${c.caseId}/${mode}`,
                      { expectedVersion: c.version, reason: why.trim() },
                      mode === 'cancel' ? 'Follow-up cancelled.' : 'Case reopened.',
                    )
              }
            >
              Confirm
            </Button>
            <Button onClick={() => setMode('none')}>Close</Button>
          </div>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
