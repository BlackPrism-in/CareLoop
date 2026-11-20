/**
 * Evidence and handoff records (MVP spec §13, §18). Written in the same
 * transaction as the case transition they cause.
 */

export type EvidenceKind = 'PROVIDER_EVENT' | 'STAFF_RECORD' | 'SELF_REPORT';
export type EvidenceEventType = 'APPOINTMENT_ATTENDED' | 'SAMPLE_COLLECTED';
export type EvidenceStatus = 'CANDIDATE' | 'VERIFIED' | 'REJECTED' | 'CONFLICTED' | 'SELF_REPORTED';

export interface EvidenceDoc {
  evidenceId: string;
  caseId: string;
  kind: EvidenceKind;
  /** Who issued it: provider system, clinic register, staff member, or "patient". */
  issuer: string;
  eventType: EvidenceEventType;
  patientRef: string | null;
  bookingRef: string | null;
  occurredAt: string;
  receivedAt: string;
  sourceRef: string;
  sourceHash: string | null;
  simulation: boolean;
  status: EvidenceStatus;
  /** Why it failed matching or awaits review; shown to staff verbatim. */
  reasons: string[];
  /** Administrative excerpt only (no report content), max 2,000 characters. */
  excerpt: string | null;
  /** Verification agent recommendation, if one was run. Never authoritative. */
  aiReview: Record<string, unknown> | null;
  recordedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
}

export type HandoffStatus = 'PENDING' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface HandoffDoc {
  handoffId: string;
  caseId: string;
  reasonCode: string;
  ownerId: string;
  status: HandoffStatus;
  createdBy: string;
  createdAt: string;
  dueAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  backupNotifiedAt: string | null;
}
