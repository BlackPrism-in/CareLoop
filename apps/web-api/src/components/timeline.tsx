import type { EventEnvelope } from '@careloop/contracts';
import { formatDateTime } from '@/lib/format';
import { SimulationBadge } from './ui';

const LABEL: Record<string, string> = {
  CASE_CREATED: 'Draft created',
  CASE_EDITED: 'Draft edited',
  CASE_EDITED_APPROVAL_INVALIDATED: 'Edited — approval invalidated',
  CASE_APPROVED: 'Reviewer approved',
  CONTACT_DISPATCHED: 'Contact attempt started',
  CONTACT_OUTCOME_RECORDED: 'Contact outcome recorded',
  PATIENT_REQUEST_RECORDED: 'Patient request recorded',
  BOOKING_REQUESTED: 'Booking requested',
  BOOKING_CONFIRMED: 'Slot acknowledged',
  BOOKING_OUTCOME_UNKNOWN: 'Booking outcome unknown',
  BOOKING_CANCELLED: 'Booking cancelled',
  AWAITING_EVIDENCE: 'Awaiting completion proof',
  SELF_REPORT_RECORDED: 'Patient self-report (unverified)',
  COMPLETION_VERIFIED: 'Completion verified',
  PATIENT_OPTED_OUT: 'Patient opted out',
  HANDOFF_CREATED: 'Handoff created',
  HANDOFF_ACKNOWLEDGED: 'Handoff acknowledged',
  HANDOFF_RESOLVED: 'Handoff resolved',
  CASE_CANCELLED: 'Case cancelled',
  CASE_REOPENED: 'Case reopened',
};

/** Immutable application events: actor, time, simulation label. */
export function Timeline({
  events,
  names,
}: {
  events: EventEnvelope[];
  names: Map<string, string>;
}) {
  if (events.length === 0) return <p className="text-sm text-[var(--muted)]">No events yet.</p>;
  return (
    <ol className="space-y-3">
      {[...events].reverse().map((e) => (
        <li key={e.eventId} className="flex gap-3 text-sm">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--muted)]" aria-hidden />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{LABEL[e.eventType] ?? e.eventType}</span>
              {e.simulation && <SimulationBadge />}
            </div>
            <div className="text-xs text-[var(--muted)]">
              {formatDateTime(e.occurredAt)} ·{' '}
              {e.actorType === 'STAFF'
                ? (names.get(e.actorId) ?? e.actorId)
                : e.actorType.toLowerCase()}{' '}
              · v{e.nextVersion}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
