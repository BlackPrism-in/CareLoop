import type { OutboxRecord } from '@careloop/domain';

export type OutboxStatus = 'PENDING' | 'DISPATCHED' | 'DONE' | 'SKIPPED' | 'FAILED';

/** Outbox document as the dispatcher and runner see it (domain writes the PENDING shape). */
export interface OutboxDoc extends Omit<OutboxRecord, 'status'> {
  status: OutboxStatus;
  leaseUntil?: string | null;
  dispatchAttempts?: number;
  dispatchedAt?: string | null;
  taskName?: string | null;
  /** Bumped by an operator replay so the new Cloud Task gets a fresh name. */
  replayCount?: number;
  sweepCount?: number;
}

export type JobStatus = 'LEASED' | 'RETRY' | 'DONE' | 'SKIPPED' | 'FAILED';

/** Durable record per outbox item: claims, attempts and the final disposition. */
export interface JobDoc {
  jobId: string;
  tenantId: string;
  caseId: string;
  kind: OutboxDoc['kind'];
  operationId: string;
  status: JobStatus;
  attempts: number;
  leaseUntil: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FailedJobDoc {
  jobId: string;
  tenantId: string;
  caseId: string;
  kind: OutboxDoc['kind'];
  operationId: string;
  reason: string;
  attempts: number;
  failedAt: string;
}

export type BookingStatus =
  | 'REQUESTED'
  | 'PENDING_STAFF'
  | 'CONFIRMED'
  | 'UNKNOWN'
  | 'REJECTED'
  | 'CANCEL_PENDING'
  | 'CANCELLED';

/** tenants/{t}/bookings/{operationId}: the booking operation and its provider outcome. */
export interface BookingDoc {
  bookingId: string;
  caseId: string;
  operationId: string;
  adapter: 'sandbox' | 'manual' | 'provider';
  slotId: string;
  status: BookingStatus;
  externalRef: string | null;
  startsAt: string | null;
  location: string | null;
  reason: string | null;
  simulation: boolean;
  confirmedBy: string | null;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
}
