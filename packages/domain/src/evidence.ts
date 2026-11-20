import type { Case, Patient } from '@careloop/contracts';
import { approvalIsCurrent } from './approval';
import type { EvidenceEventType, EvidenceKind } from './records';

export interface EvidenceCandidate {
  kind: Exclude<EvidenceKind, 'SELF_REPORT'>;
  eventType: EvidenceEventType;
  patientRef: string | null;
  bookingRef: string | null;
  occurredAt: string;
  sourceRef: string;
}

export type MatchOutcome = 'MATCH' | 'REVIEW' | 'REJECT' | 'CONFLICT';

const EXPECTED_EVENT: Record<Case['actionType'], EvidenceEventType> = {
  CONSULTATION: 'APPOINTMENT_ATTENDED',
  ORDERED_TEST: 'SAMPLE_COLLECTED',
};

/**
 * Deterministic evidence matching (MVP spec §18, MVP-08). Tenant is already
 * fixed by the caller. Checks patient reference, obligation, timing and source.
 * - REJECT: wrong patient, wrong obligation, impossible timing, no source.
 * - CONFLICT: plausible but contradicts the booking; a human must resolve it.
 * - MATCH: an authenticated provider event that passes every check.
 * - REVIEW: a staff record that passes; a named verifier must attest.
 * The case is never edited to fit the evidence.
 */
export function matchEvidence(
  c: Case,
  patient: Patient,
  ev: EvidenceCandidate,
  now: Date,
): { outcome: MatchOutcome; reasons: string[] } {
  const reject = (...reasons: string[]) => ({ outcome: 'REJECT' as const, reasons });
  if (!ev.sourceRef.trim()) return reject('SOURCE_REQUIRED');
  if (!approvalIsCurrent(c) || !c.approvedAt) return reject('NO_CURRENT_APPROVAL');
  if (ev.kind === 'PROVIDER_EVENT' && !ev.patientRef) return reject('PATIENT_REF_MISSING');
  if (ev.patientRef && ev.patientRef !== patient.externalRef) return reject('PATIENT_REF_MISMATCH');
  if (ev.eventType !== EXPECTED_EVENT[c.actionType]) return reject('OBLIGATION_MISMATCH');
  const occurred = Date.parse(ev.occurredAt);
  if (Number.isNaN(occurred)) return reject('INVALID_OCCURRENCE_TIME');
  if (occurred > now.getTime()) return reject('OCCURRENCE_IN_FUTURE');
  if (occurred < Date.parse(c.approvedAt)) return reject('OCCURRED_BEFORE_APPROVAL');
  if (ev.bookingRef && c.bookingRef && ev.bookingRef !== c.bookingRef)
    return { outcome: 'CONFLICT', reasons: ['BOOKING_REF_MISMATCH'] };
  if (ev.kind === 'PROVIDER_EVENT') return { outcome: 'MATCH', reasons: [] };
  return { outcome: 'REVIEW', reasons: ['AWAITING_ATTESTATION'] };
}
