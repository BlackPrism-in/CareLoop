'use client';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { Button, Card, Field, inputClass, Notice, SimulationBadge } from './ui';
import { api, describeError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { BookingDoc, CaseDetail, CommandResult } from '@/lib/types';
import { useData } from '@/lib/use-data';

interface SlotsResponse {
  adapter: 'sandbox' | 'manual' | 'provider';
  simulation: boolean;
  slots: { slotId: string; startsAt: string; endsAt: string; location: string }[];
}

const BOOKING_STATUS: Record<string, string> = {
  REQUESTED: 'Request sent — waiting for the calendar',
  PENDING_STAFF: 'Waiting for staff to book it (see Bookings)',
  CONFIRMED: 'Confirmed',
  UNKNOWN: 'Outcome unknown — being reconciled',
  REJECTED: 'Not possible',
  CANCEL_PENDING: 'Cancellation pending',
  CANCELLED: 'Cancelled',
};

/**
 * Contact → patient request → slot → booking (MVP spec §17). Every action is
 * a server command; this panel only shows what the server says is true.
 */
export function BookingPanel({
  detail,
  onChanged,
}: {
  detail: CaseDetail;
  onChanged: (msg: string) => void;
}) {
  const c = detail.case;
  const { hasRole } = useAuth();
  const coordinator = hasRole('COORDINATOR');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = detail.bookings.find((b) =>
    ['REQUESTED', 'PENDING_STAFF', 'UNKNOWN', 'CONFIRMED', 'CANCEL_PENDING'].includes(b.status),
  );
  const last = detail.bookings[0];
  const cancellationRequested =
    c.bookingState === 'CONFIRMED' &&
    detail.events.at(-1)?.eventType === 'BOOKING_CANCELLATION_REQUESTED';

  async function run(path: string, body: unknown, done: string) {
    setBusy(true);
    setError(null);
    try {
      await api<CommandResult>(path, { method: 'POST', body });
      onChanged(done);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Booking">
      <div className="space-y-3 text-sm">
        {active ? (
          <BookingSummary b={active} />
        ) : (
          <p>
            {last?.status === 'REJECTED'
              ? `Last request not possible (${last.reason?.toLowerCase().replaceAll('_', ' ')}).`
              : 'No booking yet.'}
          </p>
        )}

        {c.bookingState === 'UNKNOWN' && (
          <Notice tone="warn">
            The provider didn&apos;t confirm in time. CareLoop is checking whether the booking
            exists. It won&apos;t book again until that&apos;s known.
          </Notice>
        )}
        {cancellationRequested && (
          <Notice>
            Cancellation requested. The booking stays confirmed until the calendar acknowledges it —
            don&apos;t tell the patient it&apos;s cancelled yet.
          </Notice>
        )}

        {coordinator && c.workflowState === 'READY' && !c.automationPausedReason && (
          <div className="space-y-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                run(
                  `/v1/cases/${c.caseId}/contact-requests`,
                  { expectedVersion: c.version, channel: 'BROWSER_VOICE' },
                  'Contact started.',
                )
              }
            >
              Start contact (simulated session)
            </Button>
            <p className="text-xs text-[var(--muted)]">
              Re-checks approval, permission, contact hours and the attempt budget first. The voice
              agent arrives in Phase 4.
            </p>
          </div>
        )}

        {coordinator && c.workflowState === 'CONTACTING' && (
          <div className="space-y-2">
            <p className="font-medium">What did the patient ask for?</p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  run(
                    `/v1/cases/${c.caseId}/patient-requests`,
                    { expectedVersion: c.version, request: 'BOOK' },
                    'Recorded: patient wants to book.',
                  )
                }
              >
                Wants to book
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  run(
                    `/v1/cases/${c.caseId}/patient-requests`,
                    { expectedVersion: c.version, request: 'CALLBACK' },
                    'Recorded: callback requested.',
                  )
                }
              >
                Asked for a callback
              </Button>
            </div>
            <p className="text-xs text-[var(--muted)]">
              Identity check: <SimulationBadge /> in this synthetic lab.
            </p>
          </div>
        )}

        {coordinator &&
          c.workflowState === 'AWAITING_BOOKING' &&
          (c.bookingState === 'NONE' || c.bookingState === 'CANCELLED') &&
          !c.automationPausedReason && (
            <SlotPicker
              caseId={c.caseId}
              version={c.version}
              busy={busy}
              onRequest={(slotId) =>
                run(
                  `/v1/cases/${c.caseId}/booking-requests`,
                  { expectedVersion: c.version, slotId, patientConfirmedSlot: true },
                  'Booking request sent. It shows as booked only when the calendar confirms.',
                )
              }
            />
          )}

        {coordinator && active?.status === 'CONFIRMED' && !cancellationRequested && (
          <CancelBooking
            booking={active}
            version={c.version}
            busy={busy}
            onCancel={(reason) =>
              run(
                `/v1/bookings/${active.bookingId}/cancel`,
                { expectedVersion: c.version, reason },
                'Cancellation requested.',
              )
            }
          />
        )}

        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}

function BookingSummary({ b }: { b: BookingDoc }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{BOOKING_STATUS[b.status]}</span>
        {b.simulation && <SimulationBadge />}
        {b.adapter === 'manual' && b.confirmedBy && (
          <span className="rounded border border-[var(--line)] px-1.5 py-0.5 text-[11px] uppercase tracking-wide">
            Manual confirmation
          </span>
        )}
      </div>
      {b.startsAt && <div className="text-base font-medium">{formatDateTime(b.startsAt)}</div>}
      {b.location && <div className="text-[var(--muted)]">{b.location}</div>}
      {b.externalRef && (
        <div className="text-xs text-[var(--muted)]">
          Reference {b.externalRef}
          {b.lastReconciledAt ? ` · checked ${formatDateTime(b.lastReconciledAt)}` : ''}
        </div>
      )}
    </div>
  );
}

function SlotPicker({
  caseId,
  version,
  busy,
  onRequest,
}: {
  caseId: string;
  version: number;
  busy: boolean;
  onRequest: (slotId: string) => void;
}) {
  const { data, error, loading, refresh } = useData<SlotsResponse>(
    () => api<SlotsResponse>(`/v1/cases/${caseId}/slots`),
    [caseId, version],
  );
  const [slotId, setSlotId] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  if (loading && !data) return <p className="text-[var(--muted)]">Loading available times…</p>;
  if (error && !data)
    return (
      <Notice tone="error">
        {error} <Button onClick={refresh}>Retry</Button>
      </Notice>
    );
  if (!data) return null;

  if (data.adapter === 'manual') {
    return (
      <div className="space-y-2">
        <p>No calendar is connected. Staff book the time and then record the real reference.</p>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>The patient asked us to arrange it.</span>
        </label>
        <Button
          variant="primary"
          disabled={!confirmed || busy}
          onClick={() => onRequest('STAFF_ARRANGED')}
        >
          Request staff booking
        </Button>
      </div>
    );
  }

  if (data.slots.length === 0)
    return (
      <Notice tone="warn">
        No slots are available before the due date. Hand this case to staff.
      </Notice>
    );
  const chosen = data.slots.find((s) => s.slotId === slotId);
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium">
        Available times {data.simulation && <SimulationBadge />}
      </legend>
      {data.slots.map((s) => (
        <label
          key={s.slotId}
          className="flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 hover:bg-[var(--surface-2)]"
        >
          <input
            type="radio"
            name={`slot-${caseId}`}
            value={s.slotId}
            checked={slotId === s.slotId}
            onChange={() => {
              setSlotId(s.slotId);
              setConfirmed(false);
            }}
          />
          <span className="font-medium">{formatDateTime(s.startsAt)}</span>
          <span className="text-[var(--muted)]">· {s.location}</span>
        </label>
      ))}
      {chosen && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>
            I read back <strong>{formatDateTime(chosen.startsAt)}</strong> at{' '}
            <strong>{chosen.location}</strong> and the patient said yes.
          </span>
        </label>
      )}
      <Button
        variant="primary"
        disabled={!chosen || !confirmed || busy}
        onClick={() => onRequest(slotId)}
      >
        Request this booking
      </Button>
    </fieldset>
  );
}

function CancelBooking({
  booking,
  busy,
  onCancel,
}: {
  booking: BookingDoc;
  version: number;
  busy: boolean;
  onCancel: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) return <Button onClick={() => setOpen(true)}>Cancel booking…</Button>;
  return (
    <div className="space-y-2 rounded-md border border-[var(--line)] p-3">
      <Field label={`Why cancel ${booking.externalRef}?`}>
        <input
          className={inputClass}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Patient asked to cancel"
        />
      </Field>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!reason.trim() || busy}
          onClick={() => onCancel(reason.trim())}
        >
          Request cancellation
        </Button>
        <Button onClick={() => setOpen(false)}>Keep booking</Button>
      </div>
    </div>
  );
}
