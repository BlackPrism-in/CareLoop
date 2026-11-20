import { describe, expect, it } from 'vitest';
import type { Case, Patient } from '@careloop/contracts';
import { approvalHash } from './approval';
import { matchEvidence, type EvidenceCandidate } from './evidence';

const base = {
  caseId: 'c',
  siteId: 's',
  patientId: 'p',
  sourceId: 'src',
  consentId: 'k',
  actionType: 'CONSULTATION',
  actionText: 'x',
  dueAt: '2026-11-28T00:00:00.000Z',
  ownerId: 'o',
  language: 'hi-IN',
  approvalRevision: 1,
  approvedAt: '2026-11-21T00:00:00.000Z',
  approvedBy: 'r',
  contactAttempts: 1,
  audioSecondsUsed: 0,
  bookedStartsAt: '2026-11-23T11:00:00.000Z',
  bookingRef: 'sbx_1',
  activeHandoffId: null,
  workflowState: 'BOOKED',
  outreachDisposition: 'REACHED',
  handoffState: 'NONE',
  evidenceState: 'NONE',
  bookingState: 'CONFIRMED',
  automationPausedReason: null,
  fingerprint: 'f',
  version: 6,
  createdBy: 'u',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
} satisfies Omit<Case, 'approvalHash'>;
const c: Case = { ...base, approvalHash: approvalHash(base) };
const patient = { externalRef: 'ref_p' } as Patient;
const now = new Date('2026-11-23T12:00:00Z');
const ev = (o: Partial<EvidenceCandidate> = {}): EvidenceCandidate => ({
  kind: 'PROVIDER_EVENT',
  eventType: 'APPOINTMENT_ATTENDED',
  patientRef: 'ref_p',
  bookingRef: 'sbx_1',
  occurredAt: '2026-11-23T11:05:00Z',
  sourceRef: 'evt_1',
  ...o,
});

describe('matchEvidence', () => {
  it('matches an authenticated provider event that fits every check', () => {
    expect(matchEvidence(c, patient, ev(), now)).toEqual({ outcome: 'MATCH', reasons: [] });
  });
  it.each([
    [{ patientRef: 'ref_someone_else' }, 'PATIENT_REF_MISMATCH'],
    [{ patientRef: null }, 'PATIENT_REF_MISSING'],
    [{ eventType: 'SAMPLE_COLLECTED' as const }, 'OBLIGATION_MISMATCH'],
    [{ occurredAt: '2026-11-24T00:00:00Z' }, 'OCCURRENCE_IN_FUTURE'],
    [{ occurredAt: '2026-11-19T00:00:00Z' }, 'OCCURRED_BEFORE_APPROVAL'],
    [{ sourceRef: ' ' }, 'SOURCE_REQUIRED'],
  ])('rejects %o with %s', (o, reason) => {
    expect(matchEvidence(c, patient, ev(o), now)).toEqual({ outcome: 'REJECT', reasons: [reason] });
  });
  it('a different booking reference is a conflict for a human, not a rejection', () => {
    expect(matchEvidence(c, patient, ev({ bookingRef: 'sbx_other' }), now).outcome).toBe(
      'CONFLICT',
    );
  });
  it('a staff record that passes still needs a verifier', () => {
    expect(matchEvidence(c, patient, ev({ kind: 'STAFF_RECORD', patientRef: null }), now)).toEqual({
      outcome: 'REVIEW',
      reasons: ['AWAITING_ATTESTATION'],
    });
  });
  it('completion elsewhere (no booking) can still match', () => {
    expect(
      matchEvidence({ ...c, bookingRef: null }, patient, ev({ bookingRef: null }), now).outcome,
    ).toBe('MATCH');
  });
});
