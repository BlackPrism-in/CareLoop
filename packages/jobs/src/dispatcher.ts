import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { tenantCollection, tenantRecord } from '@careloop/domain';
import type { Logger } from '@careloop/observability';
import type { TaskQueue } from './queue';
import type { JobDoc, OutboxDoc } from './types';

const TERMINAL = ['DONE', 'SKIPPED', 'FAILED'] as const;

/**
 * Moves PENDING outbox items onto the queue (MVP spec §16 steps 2–4):
 * lease → create a deterministically named task → mark DISPATCHED. A crash
 * anywhere leaves the item PENDING (or with an expiring lease) for the sweep.
 */
export class OutboxDispatcher {
  private readonly clock: () => Date;
  private readonly leaseMs: number;
  private readonly staleMs: number;

  constructor(
    private readonly db: Firestore,
    private readonly queue: TaskQueue,
    private readonly log: Logger,
    opts: { clock?: () => Date; leaseMs?: number; staleMs?: number } = {},
  ) {
    this.clock = opts.clock ?? (() => new Date());
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.staleMs = opts.staleMs ?? 15 * 60_000;
  }

  /** Best-effort kick right after a command commits. Failures are left to the sweep. */
  async dispatchCase(tenantId: string, caseId: string): Promise<number> {
    try {
      const snap = await this.db
        .collection(tenantCollection(tenantId, 'outbox'))
        .where('caseId', '==', caseId)
        .where('status', '==', 'PENDING')
        .limit(20)
        .get();
      let n = 0;
      for (const d of snap.docs) if (await this.dispatchOne(d.ref)) n++;
      return n;
    } catch (e) {
      this.log.warn('dispatch kick failed; sweep will retry', {
        tenantId,
        caseId,
        error: (e as Error).message,
      });
      return 0;
    }
  }

  /** Recovery sweep: undispatched items, and dispatched items whose job never finished. */
  async sweep(limit = 100): Promise<{ dispatched: number; redelivered: number; settled: number }> {
    const pending = await this.db
      .collectionGroup('outbox')
      .where('status', '==', 'PENDING')
      .orderBy('createdAt')
      .limit(limit)
      .get();
    let dispatched = 0;
    for (const d of pending.docs) if (await this.dispatchOne(d.ref)) dispatched++;

    const cutoff = new Date(this.clock().getTime() - this.staleMs).toISOString();
    const stale = await this.db
      .collectionGroup('outbox')
      .where('status', '==', 'DISPATCHED')
      .where('dispatchedAt', '<', cutoff)
      .limit(limit)
      .get();
    let redelivered = 0;
    let settled = 0;
    for (const d of stale.docs) {
      const o = d.data() as OutboxDoc;
      const job = (await this.db.doc(tenantRecord(o.tenantId, 'jobs', o.outboxId)).get()).data() as
        JobDoc | undefined;
      if (job && (TERMINAL as readonly string[]).includes(job.status)) {
        await d.ref.update({ status: job.status });
        settled++;
        continue;
      }
      const sweepCount = (o.sweepCount ?? 0) + 1;
      await this.queue.enqueue({
        name: `${o.outboxId}-s${sweepCount}`,
        kind: o.kind,
        tenantId: o.tenantId,
        outboxId: o.outboxId,
      });
      await d.ref.update({ sweepCount, dispatchedAt: this.clock().toISOString() });
      redelivered++;
    }
    return { dispatched, redelivered, settled };
  }

  async dispatchOne(ref: DocumentReference): Promise<boolean> {
    const now = this.clock();
    const leased = await this.db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return null;
      const o = snap.data() as OutboxDoc;
      if (o.status !== 'PENDING') return null;
      if (o.leaseUntil && Date.parse(o.leaseUntil) > now.getTime()) return null;
      t.update(ref, {
        leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString(),
        dispatchAttempts: (o.dispatchAttempts ?? 0) + 1,
      });
      return o;
    });
    if (!leased) return false;
    const name = leased.replayCount ? `${leased.outboxId}-r${leased.replayCount}` : leased.outboxId;
    try {
      await this.queue.enqueue({
        name,
        kind: leased.kind,
        tenantId: leased.tenantId,
        outboxId: leased.outboxId,
      });
    } catch (e) {
      this.log.warn('task enqueue failed; lease will expire and the sweep retries', {
        outboxId: leased.outboxId,
        error: (e as Error).message,
      });
      return false;
    }
    // Only PENDING → DISPATCHED: a fast worker may already have finished the job.
    await this.db.runTransaction(async (t) => {
      const cur = (await t.get(ref)).data() as OutboxDoc | undefined;
      const patch = { dispatchedAt: this.clock().toISOString(), taskName: name, leaseUntil: null };
      t.update(ref, cur?.status === 'PENDING' ? { ...patch, status: 'DISPATCHED' } : patch);
    });
    return true;
  }
}
