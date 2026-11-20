import type {
  UsageMonth,
  Case,
  Consent,
  EventEnvelope,
  Member,
  Patient,
  Site,
  Source,
  Tenant,
} from '@careloop/contracts';
import type { OutboxDraft } from './transitions';
import type { EvidenceDoc, HandoffDoc } from './records';

/** Durable idempotency record: one per (tenant, command, idempotency key). */
export interface OperationRecord {
  operationId: string;
  command: string;
  idempotencyKey: string;
  payloadHash: string;
  caseId: string;
  result: CommandResult;
  createdAt: string;
}

/** Transactional outbox item; the Phase 3 dispatcher turns these into Cloud Tasks. */
export interface OutboxRecord {
  outboxId: string;
  tenantId: string;
  caseId: string;
  caseVersion: number;
  operationId: string;
  correlationId: string;
  kind: OutboxDraft['kind'];
  payload: Record<string, unknown>;
  status: 'PENDING';
  attempts: number;
  createdAt: string;
}

export interface CommandResult {
  caseId: string;
  version: number;
  workflowState: Case['workflowState'];
  outreachDisposition: Case['outreachDisposition'];
  handoffState: Case['handoffState'];
  evidenceState: Case['evidenceState'];
  bookingState: Case['bookingState'];
  automationPausedReason: Case['automationPausedReason'];
  eventId: string;
  eventType: string;
  /** Durable operation id; also the id of side effects it scheduled (e.g. the booking). Null for a duplicate-detection response. */
  operationId: string | null;
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
  /** e.g. DUPLICATE_SOURCE_ACTION when createCase returned an existing case. */
  warnings: string[];
}

/**
 * Reads inside one transaction. All reads happen before any write; writes are
 * buffered and committed atomically (Firestore requires reads-before-writes,
 * and transaction callbacks may re-run, so no external calls happen here).
 */
export interface Tx {
  getTenant(): Promise<Tenant | null>;
  getSite(siteId: string): Promise<Site | null>;
  getMember(uid: string): Promise<Member | null>;
  getPatient(patientId: string): Promise<Patient | null>;
  getConsent(consentId: string): Promise<Consent | null>;
  getSource(sourceId: string): Promise<Source | null>;
  getCase(caseId: string): Promise<Case | null>;
  getOperation(operationId: string): Promise<OperationRecord | null>;
  getCaseIdByFingerprint(fingerprint: string): Promise<string | null>;
  getEvidence(evidenceId: string): Promise<EvidenceDoc | null>;
  getHandoff(handoffId: string): Promise<HandoffDoc | null>;
  getUsage(month: string): Promise<UsageMonth | null>;

  putCase(c: Case): void;
  /** Fails the transaction if the fingerprint is already indexed. */
  createFingerprint(fingerprint: string, caseId: string): void;
  /** Fails the transaction if the event id exists (append-only). */
  appendEvent(e: EventEnvelope): void;
  enqueueOutbox(o: OutboxRecord): void;
  putOperation(o: OperationRecord): void;
  /** create: fails if it exists. merge: updates the given fields. */
  putEvidence(e: Partial<EvidenceDoc> & { evidenceId: string }, mode: 'create' | 'merge'): void;
  putHandoff(h: Partial<HandoffDoc> & { handoffId: string }, mode: 'create' | 'merge'): void;
  putUsage(u: UsageMonth): void;
}

export interface Store {
  runTransaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
}
