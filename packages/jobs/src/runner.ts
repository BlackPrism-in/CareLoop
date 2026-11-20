import type { Firestore } from 'firebase-admin/firestore';
import { tenantRecord } from '@careloop/domain';
import type { Logger } from '@careloop/observability';
import type { FailedJobDoc, JobDoc, OutboxDoc } from './types';

/** Retry later (provider outage, version conflict, still unknown). */
export class TransientError extends Error {}
/** Will never succeed; record a durable failure and stop retrying. */
export class PermanentError extends Error {}

export interface JobOutcome {
  status: 'DONE' | 'SKIPPED';
  result: Record<string, unknown>;
}

export type JobHandler = (job: {
  tenantId: string;
  outbox: OutboxDoc;
  attempt: number;
}) => Promise<JobOutcome>;

export interface RunResult {
  /** 2xx acknowledges the queue delivery; anything else asks Cloud Tasks to retry. */
  httpStatus: 200 | 409 | 503;
  status: 'DONE' | 'SKIPPED' | 'FAILED' | 'IGNORED' | 'DEFERRED' | 'RETRY';
  duplicate?: boolean;
  result?: Record<string, unknown>;
  caseId?: string;
}

const TERMINAL = new Set(['DONE', 'SKIPPED', 'FAILED']);

/**
 * Executes one outbox item at most once in effect (MVP spec §16):
 * claim a durable job record with a short lease → run the handler → store the
 * result or a durable failure, then acknowledge. Duplicate deliveries of a
 * finished job return the prior result; a delivery during a live lease defers.
 */
export class JobRunner {
  private readonly clock: () => Date;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly db: Firestore,
    private readonly handlers: Partial<Record<OutboxDoc['kind'], JobHandler>>,
    private readonly log: Logger,
    opts: { clock?: () => Date; leaseMs?: number; maxAttempts?: number } = {},
  ) {
    this.clock = opts.clock ?? (() => new Date());
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  async run(tenantId: string, outboxId: string): Promise<RunResult> {
    if (!/^[A-Za-z0-9_-]+$/.test(tenantId) || !/^[A-Za-z0-9_-]+$/.test(outboxId)) {
      return { httpStatus: 200, status: 'IGNORED' };
    }
    const outboxRef = this.db.doc(tenantRecord(tenantId, 'outbox', outboxId));
    const jobRef = this.db.doc(tenantRecord(tenantId, 'jobs', outboxId));
    const now = this.clock();

    const claim = await this.db.runTransaction(async (t) => {
      const [o, j] = await Promise.all([t.get(outboxRef), t.get(jobRef)]);
      if (!o.exists) return { kind: 'ignored' as const };
      const outbox = o.data() as OutboxDoc;
      const job = j.exists ? (j.data() as JobDoc) : null;
      if (job && TERMINAL.has(job.status)) return { kind: 'duplicate' as const, job };
      if (job?.status === 'LEASED' && job.leaseUntil && Date.parse(job.leaseUntil) > now.getTime())
        return { kind: 'leased' as const };
      const attempts = (job?.attempts ?? 0) + 1;
      const next: JobDoc = {
        jobId: outboxId,
        tenantId,
        caseId: outbox.caseId,
        kind: outbox.kind,
        operationId: outbox.operationId,
        status: 'LEASED',
        attempts,
        leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString(),
        result: null,
        error: job?.error ?? null,
        createdAt: job?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      };
      t.set(jobRef, next);
      return { kind: 'claimed' as const, outbox, attempts };
    });

    if (claim.kind === 'ignored') return { httpStatus: 200, status: 'IGNORED' };
    if (claim.kind === 'duplicate') {
      return {
        httpStatus: 200,
        status: claim.job.status as RunResult['status'],
        duplicate: true,
        result: claim.job.result ?? undefined,
      };
    }
    if (claim.kind === 'leased') return { httpStatus: 409, status: 'DEFERRED' };

    const handler = this.handlers[claim.outbox.kind];
    try {
      if (!handler) throw new PermanentError(`no handler for ${claim.outbox.kind}`);
      const outcome = await handler({ tenantId, outbox: claim.outbox, attempt: claim.attempts });
      await this.finish(tenantId, outboxId, outcome.status, outcome.result, null);
      return {
        httpStatus: 200,
        status: outcome.status,
        result: outcome.result,
        caseId: claim.outbox.caseId,
      };
    } catch (e) {
      const message = (e as Error).message ?? 'error';
      const permanent = e instanceof PermanentError || claim.attempts >= this.maxAttempts;
      if (permanent) {
        await this.finish(tenantId, outboxId, 'FAILED', null, message, claim);
        this.log.error('job failed permanently', {
          tenantId,
          outboxId,
          kind: claim.outbox.kind,
          attempts: claim.attempts,
        });
        return { httpStatus: 200, status: 'FAILED' };
      }
      await jobRef.update({
        status: 'RETRY',
        leaseUntil: null,
        error: message,
        updatedAt: this.clock().toISOString(),
      });
      this.log.warn('job will retry', {
        tenantId,
        outboxId,
        kind: claim.outbox.kind,
        attempts: claim.attempts,
      });
      return { httpStatus: 503, status: 'RETRY' };
    }
  }

  private async finish(
    tenantId: string,
    outboxId: string,
    status: 'DONE' | 'SKIPPED' | 'FAILED',
    result: Record<string, unknown> | null,
    error: string | null,
    claim?: { outbox: OutboxDoc; attempts: number },
  ) {
    const ts = this.clock().toISOString();
    const batch = this.db.batch();
    batch.update(this.db.doc(tenantRecord(tenantId, 'jobs', outboxId)), {
      status,
      result,
      error,
      leaseUntil: null,
      updatedAt: ts,
    });
    batch.update(this.db.doc(tenantRecord(tenantId, 'outbox', outboxId)), { status });
    if (status === 'FAILED' && claim) {
      const failed: FailedJobDoc = {
        jobId: outboxId,
        tenantId,
        caseId: claim.outbox.caseId,
        kind: claim.outbox.kind,
        operationId: claim.outbox.operationId,
        reason: error ?? 'unknown',
        attempts: claim.attempts,
        failedAt: ts,
      };
      batch.set(this.db.doc(tenantRecord(tenantId, 'failed_jobs', outboxId)), failed);
    }
    await batch.commit();
  }

  /**
   * Operator replay of a failed job. Keeps the original outbox id and
   * operation id, so provider idempotency still applies; only the queue task
   * name changes.
   */
  async replay(tenantId: string, jobId: string, actorId: string): Promise<boolean> {
    const failedRef = this.db.doc(tenantRecord(tenantId, 'failed_jobs', jobId));
    const outboxRef = this.db.doc(tenantRecord(tenantId, 'outbox', jobId));
    const jobRef = this.db.doc(tenantRecord(tenantId, 'jobs', jobId));
    return this.db.runTransaction(async (t) => {
      const [f, o] = await Promise.all([t.get(failedRef), t.get(outboxRef)]);
      if (!f.exists || !o.exists) return false;
      const outbox = o.data() as OutboxDoc;
      const ts = this.clock().toISOString();
      t.update(outboxRef, {
        status: 'PENDING',
        leaseUntil: null,
        replayCount: (outbox.replayCount ?? 0) + 1,
        lastReplayBy: actorId,
        lastReplayAt: ts,
      });
      t.update(jobRef, { status: 'RETRY', attempts: 0, leaseUntil: null, updatedAt: ts });
      t.delete(failedRef);
      return true;
    });
  }
}
