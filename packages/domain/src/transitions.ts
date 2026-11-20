import type {
  Case,
  Consent,
  ContactChannel,
  OutreachDisposition,
  Patient,
  Site,
  Tenant,
  WorkflowState,
} from '@careloop/contracts';
import {
  approvalHash,
  approvalIsCurrent,
  MATERIAL_FIELDS,
  REQUIRED_CHECKS,
  type ApprovalCheck,
  type MaterialField,
} from './approval';
import { withinContactWindow } from './contact-window';
import { guardFailed } from './errors';

/**
 * Pure transition guards (MVP spec §12). Each takes the current case plus the
 * facts it needs and returns the change to persist, or throws a DomainError.
 * No I/O happens here; the command service loads facts and writes results
 * atomically. Model output never reaches these functions directly.
 */

export interface OutboxDraft {
  kind:
    | 'CONTACT_ATTEMPT'
    | 'BOOKING_REQUEST'
    | 'BOOKING_RECONCILE'
    | 'BOOKING_CANCEL'
    | 'PROVIDER_EVENT'
    | 'HANDOFF_NOTIFY'
    | 'SUPPRESS_PENDING_WORK';
  payload: Record<string, unknown>;
}

export interface Transition {
  patch: Partial<Case>;
  eventType: string;
  payload: Record<string, unknown>;
  outbox?: OutboxDraft[];
}

const OPEN_STATES: readonly WorkflowState[] = [
  'DRAFT',
  'READY',
  'CONTACTING',
  'AWAITING_BOOKING',
  'BOOKED',
  'AWAITING_EVIDENCE',
];
const isOpen = (c: Case) => OPEN_STATES.includes(c.workflowState);

function requireState(c: Case, allowed: readonly WorkflowState[], action: string): void {
  if (!allowed.includes(c.workflowState)) {
    throw guardFailed(`INVALID_STATE_FOR_${action}`, `cannot ${action} while ${c.workflowState}`);
  }
}

export function consentIsActive(consent: Consent, now: Date, channel?: ContactChannel): boolean {
  if (consent.revokedAt !== null) return false;
  if (consent.expiresAt !== null && new Date(consent.expiresAt) <= now) return false;
  if (new Date(consent.grantedAt) > now) return false;
  return channel ? consent.channels.includes(channel) : true;
}

const SUPPRESSED: readonly OutreachDisposition[] = ['OPTED_OUT', 'DECLINED'];
const handoffOpen = (c: Case) => c.handoffState === 'PENDING' || c.handoffState === 'ACKNOWLEDGED';

// ---------------------------------------------------------------------------
// Drafting and approval

export type DraftEdit = Partial<Pick<Case, MaterialField | 'ownerId' | 'language' | 'consentId'>>;

/**
 * Edits allowed before a booking exists. A material change after approval
 * invalidates it: the case returns to DRAFT and automation pauses for review.
 * Once a booking is requested or confirmed, the booking must be reconciled
 * explicitly first (MVP spec §12).
 */
export function editDraft(c: Case, edit: DraftEdit): Transition {
  requireState(c, ['DRAFT', 'READY', 'CONTACTING', 'AWAITING_BOOKING'], 'EDIT');
  if (c.bookingState !== 'NONE' && c.bookingState !== 'CANCELLED') {
    throw guardFailed(
      'BOOKING_MUST_BE_RECONCILED',
      'reconcile the existing booking before editing',
    );
  }
  const changed = Object.entries(edit).filter(
    ([k, v]) => v !== undefined && c[k as keyof Case] !== v,
  );
  if (changed.length === 0) throw guardFailed('NO_CHANGES');
  const materialChanged = changed.some(([k]) => (MATERIAL_FIELDS as readonly string[]).includes(k));
  const consentChanged = changed.some(([k]) => k === 'consentId');
  const invalidates = c.approvalRevision > 0 && (materialChanged || consentChanged);
  const patch: Partial<Case> = Object.fromEntries(changed);
  if (invalidates) {
    Object.assign(patch, {
      workflowState: 'DRAFT',
      approvalHash: null,
      approvedAt: null,
      approvedBy: null,
      automationPausedReason: 'REVIEW_REQUIRED',
    } satisfies Partial<Case>);
  }
  return {
    patch,
    eventType: invalidates ? 'CASE_EDITED_APPROVAL_INVALIDATED' : 'CASE_EDITED',
    payload: { fields: changed.map(([k]) => k).sort() },
    outbox: invalidates
      ? [{ kind: 'SUPPRESS_PENDING_WORK', payload: { reason: 'APPROVAL_INVALIDATED' } }]
      : [],
  };
}

export interface ApproveInput {
  reviewerId: string;
  sourceAuthorityRef: string;
  checkedFields: readonly string[];
  now: Date;
}

/** DRAFT → READY. Requires every checklist item, an active consent and an adult patient. */
export function approve(
  c: Case,
  facts: { consent: Consent; patient: Patient; ownerIsActiveMember: boolean },
  input: ApproveInput,
): Transition {
  requireState(c, ['DRAFT'], 'APPROVE');
  const missing = REQUIRED_CHECKS.filter((f) => !input.checkedFields.includes(f));
  if (missing.length > 0)
    throw guardFailed('APPROVAL_CHECKLIST_INCOMPLETE', `unchecked: ${missing.join(', ')}`);
  if (!input.sourceAuthorityRef.trim()) throw guardFailed('SOURCE_AUTHORITY_REQUIRED');
  if (facts.patient.patientId !== c.patientId || facts.consent.patientId !== c.patientId) {
    throw guardFailed('PATIENT_MISMATCH');
  }
  if (facts.patient.ageEligibility !== 'ADULT_CONFIRMED')
    throw guardFailed('ADULT_ELIGIBILITY_NOT_CONFIRMED');
  if (!consentIsActive(facts.consent, input.now)) throw guardFailed('CONTACT_BASIS_MISSING');
  if (!facts.ownerIsActiveMember) throw guardFailed('OWNER_NOT_ACTIVE');
  if (new Date(c.dueAt) <= input.now) throw guardFailed('DUE_DATE_IN_PAST');

  const revision = c.approvalRevision + 1;
  const hash = approvalHash({ ...c, approvalRevision: revision });
  const pausedForOptOut = SUPPRESSED.includes(c.outreachDisposition);
  return {
    patch: {
      workflowState: 'READY',
      approvalRevision: revision,
      approvalHash: hash,
      approvedAt: input.now.toISOString(),
      approvedBy: input.reviewerId,
      automationPausedReason: pausedForOptOut ? 'CONSENT' : null,
    },
    eventType: 'CASE_APPROVED',
    payload: {
      approvalRevision: revision,
      approvalHash: hash,
      sourceAuthorityRef: input.sourceAuthorityRef,
      checkedFields: [...input.checkedFields].sort() as ApprovalCheck[],
    },
  };
}

// ---------------------------------------------------------------------------
// Outreach

export interface DispatchFacts {
  tenant: Tenant;
  site: Site;
  consent: Consent;
  patient: Patient;
  outreachEnabled: boolean;
  maxContactAttempts: number;
  maxCaseAudioSeconds: number;
  now: Date;
  channel: ContactChannel;
}

/**
 * READY (or a scheduled retry while CONTACTING) → CONTACTING. Every check is
 * re-run at execution time (MVP-03); queue cancellation is only a convenience.
 * Atomically consumes one contact attempt.
 */
export function dispatchContact(c: Case, f: DispatchFacts): Transition {
  const isRetry = c.workflowState === 'CONTACTING' && c.outreachDisposition === 'RETRY_SCHEDULED';
  if (!(c.workflowState === 'READY' || isRetry)) requireState(c, ['READY'], 'DISPATCH');
  // The kill switch guards contact with real people. A synthetic tenant's
  // browser-voice session reaches no one, so the demo can run with it off.
  const simulatedOnly = f.tenant.simulation && f.channel === 'BROWSER_VOICE';
  if (!f.outreachEnabled && !simulatedOnly) throw guardFailed('OUTREACH_DISABLED');
  if (f.tenant.outreachPaused) throw guardFailed('SITE_PAUSED');
  if (c.automationPausedReason !== null)
    throw guardFailed(`AUTOMATION_PAUSED_${c.automationPausedReason}`);
  if (!approvalIsCurrent(c)) throw guardFailed('APPROVAL_NOT_CURRENT');
  if (SUPPRESSED.includes(c.outreachDisposition)) throw guardFailed('PATIENT_SUPPRESSED');
  if (f.patient.ageEligibility !== 'ADULT_CONFIRMED')
    throw guardFailed('ADULT_ELIGIBILITY_NOT_CONFIRMED');
  if (!consentIsActive(f.consent, f.now, f.channel))
    throw guardFailed('CONSENT_NOT_ACTIVE_FOR_CHANNEL');
  if (f.patient.language !== c.language) throw guardFailed('LANGUAGE_MISMATCH');
  if (!withinContactWindow(f.now, f.site.contactWindow, f.site.timeZone))
    throw guardFailed('OUTSIDE_CONTACT_WINDOW');
  if (c.contactAttempts >= f.maxContactAttempts) throw guardFailed('CONTACT_ATTEMPTS_EXHAUSTED');
  if (c.audioSecondsUsed >= f.maxCaseAudioSeconds) throw guardFailed('AUDIO_BUDGET_EXHAUSTED');

  const attempt = c.contactAttempts + 1;
  return {
    patch: { workflowState: 'CONTACTING', contactAttempts: attempt },
    eventType: 'CONTACT_DISPATCHED',
    payload: { attempt, channel: f.channel, approvalRevision: c.approvalRevision },
    outbox: [
      {
        kind: 'CONTACT_ATTEMPT',
        payload: { attempt, channel: f.channel, approvalRevision: c.approvalRevision },
      },
    ],
  };
}

export type ContactOutcome = 'REACHED' | 'RETRY_SCHEDULED' | 'UNREACHABLE' | 'DECLINED';

/**
 * Records how an attempt ended. None of these imply completion. UNREACHABLE
 * and DECLINED stop automation and hand the case to a named human.
 */
export function recordContactOutcome(
  c: Case,
  input: { outcome: ContactOutcome; audioSeconds: number; maxContactAttempts: number },
): Transition {
  requireState(c, ['CONTACTING', 'AWAITING_BOOKING'], 'RECORD_CONTACT_OUTCOME');
  if (!Number.isInteger(input.audioSeconds) || input.audioSeconds < 0)
    throw guardFailed('INVALID_AUDIO_SECONDS');
  let outcome: OutreachDisposition = input.outcome;
  if (outcome === 'RETRY_SCHEDULED' && c.contactAttempts >= input.maxContactAttempts)
    outcome = 'UNREACHABLE';
  const stops = outcome === 'UNREACHABLE' || outcome === 'DECLINED';
  return {
    patch: {
      outreachDisposition: outcome,
      audioSecondsUsed: c.audioSecondsUsed + input.audioSeconds,
      ...(stops
        ? {
            automationPausedReason: 'HANDOFF' as const,
            ...(handoffOpen(c) ? {} : { handoffState: 'PENDING' as const }),
          }
        : {}),
    },
    eventType: 'CONTACT_OUTCOME_RECORDED',
    payload: { outcome, requested: input.outcome, audioSeconds: input.audioSeconds },
    outbox: stops
      ? [{ kind: 'HANDOFF_NOTIFY', payload: { reasonCode: `CONTACT_${outcome}` } }]
      : [],
  };
}

/**
 * A voice interaction finished. Always records billed audio (budget, MVP spec
 * §11). If the case is still CONTACTING, the outcome also sets the outreach
 * disposition (e.g. no answer → retry or unreachable). Never implies completion.
 */
export function recordInteractionEnded(
  c: Case,
  input: {
    interactionId: string;
    audioSeconds: number;
    outcome: ContactOutcome | null;
    maxContactAttempts: number;
  },
): Transition {
  if (
    c.workflowState === 'DRAFT' ||
    c.workflowState === 'CANCELLED' ||
    c.workflowState === 'COMPLETED_VERIFIED'
  ) {
    throw guardFailed('INVALID_STATE_FOR_INTERACTION');
  }
  if (!Number.isInteger(input.audioSeconds) || input.audioSeconds < 0)
    throw guardFailed('INVALID_AUDIO_SECONDS');
  if (input.outcome && c.workflowState === 'CONTACTING') {
    const t = recordContactOutcome(c, {
      outcome: input.outcome,
      audioSeconds: input.audioSeconds,
      maxContactAttempts: input.maxContactAttempts,
    });
    return {
      ...t,
      eventType: 'INTERACTION_ENDED',
      payload: { ...t.payload, interactionId: input.interactionId },
    };
  }
  return {
    patch: { audioSecondsUsed: c.audioSecondsUsed + input.audioSeconds },
    eventType: 'INTERACTION_ENDED',
    payload: {
      interactionId: input.interactionId,
      audioSeconds: input.audioSeconds,
      outcome: input.outcome,
    },
  };
}

/** CONTACTING → AWAITING_BOOKING: identity verified for this interaction and an explicit patient request. */
export function recordPatientRequest(
  c: Case,
  input: {
    interactionId: string;
    identityAssurance: 'VERIFIED' | 'SIMULATED';
    request: 'BOOK' | 'CALLBACK';
  },
): Transition {
  requireState(c, ['CONTACTING'], 'RECORD_PATIENT_REQUEST');
  if (!approvalIsCurrent(c)) throw guardFailed('APPROVAL_NOT_CURRENT');
  if (SUPPRESSED.includes(c.outreachDisposition)) throw guardFailed('PATIENT_SUPPRESSED');
  const callback = input.request === 'CALLBACK';
  return {
    patch: {
      workflowState: 'AWAITING_BOOKING',
      outreachDisposition: 'REACHED',
      ...(callback && !handoffOpen(c) ? { handoffState: 'PENDING' as const } : {}),
    },
    eventType: 'PATIENT_REQUEST_RECORDED',
    payload: {
      interactionId: input.interactionId,
      identityAssurance: input.identityAssurance,
      request: input.request,
    },
    outbox: callback
      ? [{ kind: 'HANDOFF_NOTIFY', payload: { reasonCode: 'CALLBACK_REQUESTED' } }]
      : [],
  };
}

// ---------------------------------------------------------------------------
// Booking

/** Reserve a booking operation for an explicitly confirmed, adapter-returned slot (MVP-04). */
export function requestBooking(
  c: Case,
  input: { slotId: string; patientConfirmedSlot: boolean; operationId: string },
): Transition {
  requireState(c, ['AWAITING_BOOKING'], 'REQUEST_BOOKING');
  if (!approvalIsCurrent(c)) throw guardFailed('APPROVAL_NOT_CURRENT');
  if (SUPPRESSED.includes(c.outreachDisposition)) throw guardFailed('PATIENT_SUPPRESSED');
  if (!input.patientConfirmedSlot) throw guardFailed('SLOT_NOT_CONFIRMED_BY_PATIENT');
  if (c.bookingState === 'UNKNOWN') throw guardFailed('BOOKING_UNKNOWN_RECONCILE_FIRST');
  if (c.bookingState === 'REQUESTED' || c.bookingState === 'CONFIRMED')
    throw guardFailed('BOOKING_ALREADY_ACTIVE');
  return {
    patch: { bookingState: 'REQUESTED' },
    eventType: 'BOOKING_REQUESTED',
    payload: { slotId: input.slotId, operationId: input.operationId },
    outbox: [
      {
        kind: 'BOOKING_REQUEST',
        payload: { slotId: input.slotId, operationId: input.operationId },
      },
    ],
  };
}

/** → BOOKED only with a persisted reservation acknowledgment (MVP-05). A task or email is not enough. */
export function confirmBooking(
  c: Case,
  input: {
    externalRef: string;
    startsAt: string;
    adapter: 'sandbox' | 'manual' | 'provider';
    simulation: boolean;
  },
): Transition {
  requireState(c, ['AWAITING_BOOKING'], 'CONFIRM_BOOKING');
  if (c.bookingState !== 'REQUESTED' && c.bookingState !== 'UNKNOWN') {
    throw guardFailed('NO_PENDING_BOOKING_REQUEST');
  }
  if (!input.externalRef.trim()) throw guardFailed('RESERVATION_REFERENCE_REQUIRED');
  if (Number.isNaN(Date.parse(input.startsAt))) throw guardFailed('INVALID_BOOKING_TIME');
  return {
    patch: {
      bookingState: 'CONFIRMED',
      workflowState: 'BOOKED',
      bookedStartsAt: new Date(input.startsAt).toISOString(),
      bookingRef: input.externalRef,
    },
    eventType: 'BOOKING_CONFIRMED',
    payload: {
      externalRef: input.externalRef,
      startsAt: input.startsAt,
      adapter: input.adapter,
      simulation: input.simulation,
    },
  };
}

/** Timeout or lost acknowledgment: the side effect may have happened. Never FAILED, never blind retry. */
export function markBookingUnknown(c: Case, input: { operationId: string }): Transition {
  if (c.bookingState !== 'REQUESTED') throw guardFailed('NO_PENDING_BOOKING_REQUEST');
  return {
    patch: { bookingState: 'UNKNOWN', automationPausedReason: 'INTEGRATION' },
    eventType: 'BOOKING_OUTCOME_UNKNOWN',
    payload: { operationId: input.operationId },
    outbox: [{ kind: 'BOOKING_RECONCILE', payload: { operationId: input.operationId } }],
  };
}

/**
 * Acknowledged cancellation. Scheduling reopens only if the instruction and
 * consent still apply; otherwise automation stays paused for review.
 */
export function recordBookingCancelled(
  c: Case,
  input: { externalRef: string; consent: Consent; now: Date },
): Transition {
  requireState(c, ['AWAITING_BOOKING', 'BOOKED', 'AWAITING_EVIDENCE'], 'RECORD_BOOKING_CANCELLED');
  if (c.bookingState === 'NONE' || c.bookingState === 'CANCELLED')
    throw guardFailed('NO_ACTIVE_BOOKING');
  const canReschedule =
    approvalIsCurrent(c) &&
    consentIsActive(input.consent, input.now) &&
    !SUPPRESSED.includes(c.outreachDisposition);
  return {
    patch: {
      bookingState: 'CANCELLED',
      bookedStartsAt: null,
      bookingRef: null,
      workflowState: 'AWAITING_BOOKING',
      automationPausedReason: canReschedule ? c.automationPausedReason : 'REVIEW_REQUIRED',
    },
    eventType: 'BOOKING_CANCELLED',
    payload: { externalRef: input.externalRef, rescheduleAllowed: canReschedule },
  };
}

/**
 * The provider (or reconciliation) established that no reservation exists:
 * slot taken, incompatible, or never reserved. Scheduling can be retried with
 * another adapter-returned slot. Never used when the outcome is uncertain.
 */
export function recordBookingRejected(
  c: Case,
  input: { reason: string; operationId: string },
): Transition {
  if (c.bookingState !== 'REQUESTED' && c.bookingState !== 'UNKNOWN')
    throw guardFailed('NO_PENDING_BOOKING_REQUEST');
  if (!input.reason.trim()) throw guardFailed('REASON_REQUIRED');
  return {
    patch: {
      bookingState: 'NONE',
      ...(c.automationPausedReason === 'INTEGRATION' ? { automationPausedReason: null } : {}),
    },
    eventType: 'BOOKING_REJECTED',
    payload: { reason: input.reason, operationId: input.operationId },
  };
}

/**
 * Asks the adapter to cancel. The booking stays CONFIRMED until the provider
 * acknowledges; the patient must not be told it is cancelled before then.
 */
export function requestBookingCancellation(
  c: Case,
  input: { externalRef: string; reason: string },
): Transition {
  if (c.bookingState !== 'CONFIRMED') throw guardFailed('NO_CONFIRMED_BOOKING');
  if (!input.reason.trim()) throw guardFailed('REASON_REQUIRED');
  return {
    patch: {},
    eventType: 'BOOKING_CANCELLATION_REQUESTED',
    payload: { externalRef: input.externalRef, reason: input.reason },
    outbox: [{ kind: 'BOOKING_CANCEL', payload: { externalRef: input.externalRef } }],
  };
}

// ---------------------------------------------------------------------------
// Evidence and completion

/** BOOKED → AWAITING_EVIDENCE once the occurrence has passed or a completion claim arrives. Never completes. */
export function awaitEvidence(
  c: Case,
  input: { now: Date; trigger: 'OCCURRENCE_PASSED' | 'COMPLETION_CLAIM' },
): Transition {
  requireState(c, ['BOOKED'], 'AWAIT_EVIDENCE');
  if (
    input.trigger === 'OCCURRENCE_PASSED' &&
    (!c.bookedStartsAt || new Date(c.bookedStartsAt) > input.now)
  ) {
    throw guardFailed('OCCURRENCE_NOT_PASSED');
  }
  return {
    patch: { workflowState: 'AWAITING_EVIDENCE' },
    eventType: 'AWAITING_EVIDENCE',
    payload: { trigger: input.trigger },
  };
}

/** Patient says it happened. Shown separately; never counts as verified (MVP spec §18). */
export function recordSelfReport(
  c: Case,
  input: { statedOccurredAt?: string; interactionId?: string },
): Transition {
  if (!isOpen(c) || c.workflowState === 'DRAFT') throw guardFailed('INVALID_STATE_FOR_SELF_REPORT');
  if (c.evidenceState === 'VERIFIED') throw guardFailed('ALREADY_VERIFIED');
  return {
    patch: { evidenceState: 'SELF_REPORTED' },
    eventType: 'SELF_REPORT_RECORDED',
    payload: {
      statedOccurredAt: input.statedOccurredAt ?? null,
      interactionId: input.interactionId ?? null,
    },
  };
}

/** Outcome of matching an evidence candidate. Mismatches stay unresolved; the case is never edited to fit. */
export function recordEvidenceReview(
  c: Case,
  input: {
    evidenceId: string;
    result: 'UNDER_REVIEW' | 'REJECTED' | 'CONFLICTED';
    reasonCode: string;
  },
): Transition {
  if (!isOpen(c) || c.workflowState === 'DRAFT') throw guardFailed('INVALID_STATE_FOR_EVIDENCE');
  if (!input.reasonCode.trim()) throw guardFailed('REASON_REQUIRED');
  return {
    patch: { evidenceState: input.result },
    eventType: `EVIDENCE_${input.result}`,
    payload: { evidenceId: input.evidenceId, reasonCode: input.reasonCode },
  };
}

export type CompletionEvidence =
  | {
      kind: 'TRUSTED_EVENT';
      evidenceId: string;
      occurredAt: string;
      sourceRef: string;
      matched: true;
    }
  | {
      kind: 'STAFF_ATTESTATION';
      evidenceId: string;
      occurredAt: string;
      sourceRef: string;
      verifierId: string;
      reason: string;
    };

/**
 * Any eligible open state → COMPLETED_VERIFIED (MVP-09). Requires an approval
 * that was valid when the event occurred, no unresolved conflict, and either a
 * deterministic trusted match or a named verifier's attestation with source
 * and reason. A booking is not required: completion elsewhere counts if verified.
 */
export function verifyCompletion(c: Case, ev: CompletionEvidence, now: Date): Transition {
  requireState(
    c,
    ['READY', 'CONTACTING', 'AWAITING_BOOKING', 'BOOKED', 'AWAITING_EVIDENCE'],
    'VERIFY_COMPLETION',
  );
  if (!approvalIsCurrent(c) || !c.approvedAt) throw guardFailed('APPROVAL_NOT_CURRENT');
  if (c.evidenceState === 'CONFLICTED') throw guardFailed('RESOLVE_CONFLICT_FIRST');
  const occurred = Date.parse(ev.occurredAt);
  if (Number.isNaN(occurred)) throw guardFailed('INVALID_OCCURRENCE_TIME');
  if (occurred > now.getTime()) throw guardFailed('OCCURRENCE_IN_FUTURE');
  if (occurred < Date.parse(c.approvedAt)) throw guardFailed('OCCURRED_BEFORE_APPROVAL');
  if (!ev.sourceRef.trim()) throw guardFailed('EVIDENCE_SOURCE_REQUIRED');
  if (ev.kind === 'STAFF_ATTESTATION' && !ev.reason.trim())
    throw guardFailed('ATTESTATION_REASON_REQUIRED');
  return {
    patch: { workflowState: 'COMPLETED_VERIFIED', evidenceState: 'VERIFIED' },
    eventType: 'COMPLETION_VERIFIED',
    payload: {
      evidenceId: ev.evidenceId,
      kind: ev.kind,
      occurredAt: ev.occurredAt,
      sourceRef: ev.sourceRef,
      onTime: occurred <= Date.parse(c.dueAt),
      ...(ev.kind === 'STAFF_ATTESTATION' ? { verifierId: ev.verifierId, reason: ev.reason } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Consent, handoff, cancellation, reopen

/**
 * Suppression is committed immediately (MVP-07). It does NOT cancel the
 * clinical obligation; the case stays open for staff. Pending jobs re-check
 * and exit; the outbox item lets workers end active sessions politely.
 */
export function optOut(
  c: Case,
  input: { channel: 'ALL' | ContactChannel; source: string },
): Transition {
  if (c.outreachDisposition === 'OPTED_OUT') throw guardFailed('ALREADY_OPTED_OUT');
  return {
    patch: { outreachDisposition: 'OPTED_OUT', automationPausedReason: 'CONSENT' },
    eventType: 'PATIENT_OPTED_OUT',
    payload: { channel: input.channel, source: input.source },
    outbox: [{ kind: 'SUPPRESS_PENDING_WORK', payload: { reason: 'OPTED_OUT' } }],
  };
}

/** A medical question, unresolved barrier or failure becomes a named human task. Severity is never assigned. */
export function createHandoff(
  c: Case,
  input: { reasonCode: string; ownerId: string; dueAt: string },
): Transition {
  if (!isOpen(c)) throw guardFailed('CASE_CLOSED');
  if (c.handoffState === 'PENDING' || c.handoffState === 'ACKNOWLEDGED')
    throw guardFailed('HANDOFF_ALREADY_OPEN');
  if (!input.reasonCode.trim()) throw guardFailed('REASON_REQUIRED');
  return {
    patch: { handoffState: 'PENDING', automationPausedReason: 'HANDOFF' },
    eventType: 'HANDOFF_CREATED',
    payload: { reasonCode: input.reasonCode, ownerId: input.ownerId, dueAt: input.dueAt },
    outbox: [
      { kind: 'HANDOFF_NOTIFY', payload: { reasonCode: input.reasonCode, ownerId: input.ownerId } },
    ],
  };
}

/** A named person takes responsibility. This does NOT complete the follow-up (MVP-11). */
export function acknowledgeHandoff(c: Case, input: { staffId: string }): Transition {
  if (c.handoffState !== 'PENDING') throw guardFailed('NO_PENDING_HANDOFF');
  return {
    patch: { handoffState: 'ACKNOWLEDGED' },
    eventType: 'HANDOFF_ACKNOWLEDGED',
    payload: { staffId: input.staffId },
  };
}

/** Moves an open handoff to another named staff member. */
export function reassignHandoff(c: Case, input: { ownerId: string }): Transition {
  if (c.handoffState !== 'PENDING' && c.handoffState !== 'ACKNOWLEDGED')
    throw guardFailed('NO_OPEN_HANDOFF');
  return {
    patch: { handoffState: 'PENDING' },
    eventType: 'HANDOFF_REASSIGNED',
    payload: { ownerId: input.ownerId },
    outbox: [
      { kind: 'HANDOFF_NOTIFY', payload: { reasonCode: 'REASSIGNED', ownerId: input.ownerId } },
    ],
  };
}

/** Resolves the task; automation resumes only if nothing else is blocking it. */
export function resolveHandoff(
  c: Case,
  input: { staffId: string; resolution: string; resumeAutomation: boolean },
): Transition {
  if (c.handoffState !== 'ACKNOWLEDGED') throw guardFailed('HANDOFF_NOT_ACKNOWLEDGED');
  if (!input.resolution.trim()) throw guardFailed('RESOLUTION_REQUIRED');
  const canResume =
    input.resumeAutomation &&
    c.automationPausedReason === 'HANDOFF' &&
    !SUPPRESSED.includes(c.outreachDisposition);
  return {
    patch: { handoffState: 'RESOLVED', ...(canResume ? { automationPausedReason: null } : {}) },
    eventType: 'HANDOFF_RESOLVED',
    payload: { staffId: input.staffId, resolution: input.resolution, automationResumed: canResume },
  };
}

/** Authorized withdrawal of the obligation itself. Opt-out is not cancellation. */
export function cancelCase(c: Case, input: { reason: string }): Transition {
  if (!isOpen(c)) throw guardFailed('CASE_CLOSED');
  if (!input.reason.trim()) throw guardFailed('REASON_REQUIRED');
  const hasBooking =
    c.bookingState === 'REQUESTED' ||
    c.bookingState === 'CONFIRMED' ||
    c.bookingState === 'UNKNOWN';
  return {
    patch: { workflowState: 'CANCELLED', automationPausedReason: null },
    eventType: 'CASE_CANCELLED',
    payload: { reason: input.reason, bookingNeedsReconciliation: hasBooking },
    outbox: [
      { kind: 'SUPPRESS_PENDING_WORK', payload: { reason: 'CASE_CANCELLED' } },
      ...(hasBooking
        ? [{ kind: 'BOOKING_RECONCILE' as const, payload: { reason: 'CASE_CANCELLED' } }]
        : []),
    ],
  };
}

/**
 * Authorized correction. History is preserved (events are append-only); a
 * reopened completion goes back to evidence review, a reopened cancellation
 * needs a fresh approval.
 */
export function reopenCase(c: Case, input: { reason: string }): Transition {
  requireState(c, ['COMPLETED_VERIFIED', 'CANCELLED'], 'REOPEN');
  if (!input.reason.trim()) throw guardFailed('REASON_REQUIRED');
  const fromCompleted = c.workflowState === 'COMPLETED_VERIFIED';
  return {
    patch: fromCompleted
      ? { workflowState: 'AWAITING_EVIDENCE', evidenceState: 'UNDER_REVIEW' }
      : {
          workflowState: 'DRAFT',
          approvalHash: null,
          approvedAt: null,
          approvedBy: null,
          automationPausedReason: 'REVIEW_REQUIRED',
        },
    eventType: 'CASE_REOPENED',
    payload: { reason: input.reason, from: c.workflowState },
  };
}
