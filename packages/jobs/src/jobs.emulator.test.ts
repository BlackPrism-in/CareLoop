import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Case, Slot } from '@careloop/contracts';
import {
  ManualBookingAdapter,
  SandboxBookingAdapter,
  type BookingAdapter,
} from '@careloop/adapters';
import { CaseCommands, FirestoreStore, tenantCollection, tenantRecord } from '@careloop/domain';
import {
  coordinator,
  DEFAULT_CONFIG,
  Driver,
  reviewer,
  seedWorld,
  START,
  T1,
} from '@careloop/domain/testing';
import { createLogger } from '@careloop/observability';
import { OutboxDispatcher } from './dispatcher';
import { createHandlers } from './handlers';
import { MemoryQueue } from './queue';
import { JobRunner, type RunResult } from './runner';
import type { BookingDoc, OutboxDoc } from './types';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) throw new Error('run via `pnpm test:emulator`');
const projectId = 'demo-careloop-jobs';
const app = getApps()[0] ?? initializeApp({ projectId });
const db = getFirestore(app);

// Let in-flight background writes settle, then close gRPC streams so the emulator can shut down cleanly.
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await db.terminate();
});
const log = createLogger('jobs-test');

const slot = (slotId: string, startsAt: string, capacity = 1): Slot => ({
  slotId,
  siteId: 'site_1',
  actionType: 'CONSULTATION',
  location: 'Demo Clinic, Room 2',
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
  capacity,
  reserved: 0,
});

/** Sandbox whose reconcile can be made to throw, to drive retries to a durable failure. */
class FlakySandbox extends SandboxBookingAdapter {
  reconcileFails = false;
  override async reconcile(ctx: Parameters<SandboxBookingAdapter['reconcile']>[0]) {
    if (this.reconcileFails) throw new Error('provider unavailable');
    return super.reconcile(ctx);
  }
}

describe('outbox → queue → worker → booking (Firestore emulator)', () => {
  let now: Date;
  let commands: CaseCommands;
  let sandbox: FlakySandbox;
  let queue: MemoryQueue;
  let dispatcher: OutboxDispatcher;
  let runner: JobRunner;
  const clock = () => now;

  const getCase = async (id = 'CL-1') =>
    (await db.doc(tenantRecord(T1, 'cases', id)).get()).data() as Case;
  const getSlot = async (id = 'slot_1') =>
    (await db.doc(tenantRecord(T1, 'slots', id)).get()).data() as Slot;
  const reservations = async () =>
    (await db.collection(tenantCollection(T1, 'sandbox_reservations')).get()).docs.map((d) =>
      d.data(),
    );
  const outbox = async () =>
    (await db.collection(tenantCollection(T1, 'outbox')).get()).docs.map(
      (d) => d.data() as OutboxDoc,
    );
  const bookings = async () =>
    (await db.collection(tenantCollection(T1, 'bookings')).get()).docs.map(
      (d) => d.data() as BookingDoc,
    );

  function withAdapter(adapter: BookingAdapter) {
    runner = new JobRunner(
      db,
      createHandlers({ db, commands, booking: adapter, log, clock }),
      log,
      { clock },
    );
  }

  async function deliver(): Promise<RunResult[]> {
    const out: RunResult[] = [];
    for (const t of queue.drain()) out.push(await runner.run(t.tenantId, t.outboxId));
    return out;
  }

  /** Dispatch and run until no work is left (bounded). */
  async function pump(caseId = 'CL-1') {
    const results: RunResult[] = [];
    for (let i = 0; i < 6; i++) {
      await dispatcher.dispatchCase(T1, caseId);
      const r = await deliver();
      if (r.length === 0) break;
      results.push(...r);
    }
    return results;
  }

  async function toBookingRequested(
    d: Driver,
    slotId = 'slot_1',
    over: Parameters<Driver['create']>[0] = {},
  ) {
    await d.create(over);
    await d.approve();
    await d.dispatch();
    await d.patientBooks();
    return d.requestBooking(slotId);
  }

  beforeEach(async () => {
    await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, {
      method: 'DELETE',
    });
    await seedWorld({ seed: (p, data) => db.doc(p).set(data) });
    await db
      .doc(tenantRecord(T1, 'slots', 'slot_1'))
      .set(slot('slot_1', '2026-11-23T11:00:00.000Z'));
    await db
      .doc(tenantRecord(T1, 'slots', 'slot_2'))
      .set(slot('slot_2', '2026-11-24T11:00:00.000Z'));
    now = new Date(START);
    commands = new CaseCommands({ store: new FirestoreStore(db), config: DEFAULT_CONFIG, clock });
    sandbox = new FlakySandbox(db, clock);
    queue = new MemoryQueue();
    dispatcher = new OutboxDispatcher(db, queue, log, { clock });
    withAdapter(sandbox);
  });

  it('MVP-05: a requested booking becomes BOOKED only after the adapter acknowledges it', async () => {
    const d = new Driver(commands);
    const req = await toBookingRequested(d);
    expect(req.bookingState).toBe('REQUESTED');
    await pump();
    const c = await getCase();
    expect(c.workflowState).toBe('BOOKED');
    expect(c.bookingState).toBe('CONFIRMED');
    expect(c.bookedStartsAt).toBe('2026-11-23T11:00:00.000Z');
    expect((await getSlot()).reserved).toBe(1);
    const [b] = await bookings();
    expect(b).toMatchObject({ status: 'CONFIRMED', adapter: 'sandbox', simulation: true });
    expect(b!.externalRef).toMatch(/^sbx_/);
  });

  it('MVP-10: repeated dispatch and repeated delivery create one task and one reservation', async () => {
    await toBookingRequested(new Driver(commands));
    await dispatcher.dispatchCase(T1, 'CL-1');
    await dispatcher.dispatchCase(T1, 'CL-1'); // already DISPATCHED → nothing new
    const tasks = queue.drain().filter((t) => t.kind === 'BOOKING_REQUEST');
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(await queue.enqueue({ ...t })).toBe('ALREADY_EXISTS'); // deterministic task name
    const first = await runner.run(t.tenantId, t.outboxId);
    const again = await runner.run(t.tenantId, t.outboxId); // Cloud Tasks duplicate delivery
    expect(first.status).toBe('DONE');
    expect(again).toMatchObject({ httpStatus: 200, status: 'DONE', duplicate: true });
    expect(await reservations()).toHaveLength(1);
    expect((await getSlot()).reserved).toBe(1);
  });

  it('crash before task creation: the recovery sweep dispatches the pending item', async () => {
    await toBookingRequested(new Driver(commands));
    // No kick: as if the API process died right after the transaction committed.
    const swept = await dispatcher.sweep();
    expect(swept.dispatched).toBeGreaterThanOrEqual(1);
    await deliver();
    expect((await getCase()).workflowState).toBe('BOOKED');
  });

  it('a delivery during a live lease defers; after the lease expires the job runs once', async () => {
    await toBookingRequested(new Driver(commands));
    await dispatcher.dispatchCase(T1, 'CL-1');
    const t = queue.drain().find((x) => x.kind === 'BOOKING_REQUEST')!;
    // Simulate a worker that claimed the job and crashed mid-way.
    await db.doc(tenantRecord(T1, 'jobs', t.outboxId)).set({
      jobId: t.outboxId,
      tenantId: T1,
      caseId: 'CL-1',
      kind: 'BOOKING_REQUEST',
      operationId: 'x',
      status: 'LEASED',
      attempts: 1,
      leaseUntil: new Date(now.getTime() + 60_000).toISOString(),
      result: null,
      error: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(await runner.run(T1, t.outboxId)).toMatchObject({ httpStatus: 409, status: 'DEFERRED' });
    expect(await reservations()).toHaveLength(0);
    now = new Date(now.getTime() + 61_000);
    expect((await runner.run(T1, t.outboxId)).status).toBe('DONE');
    expect(await reservations()).toHaveLength(1);
  });

  it('provider succeeds then times out: UNKNOWN, then reconciliation finds the same booking', async () => {
    await toBookingRequested(new Driver(commands));
    sandbox.fault = 'TIMEOUT_AFTER_COMMIT';
    await dispatcher.dispatchCase(T1, 'CL-1');
    await deliver();
    let c = await getCase();
    expect(c.bookingState).toBe('UNKNOWN');
    expect(c.workflowState).toBe('AWAITING_BOOKING');
    expect(c.automationPausedReason).toBe('INTEGRATION');
    sandbox.fault = 'NONE';
    await pump(); // runs BOOKING_RECONCILE
    c = await getCase();
    expect(c.workflowState).toBe('BOOKED');
    expect(await reservations()).toHaveLength(1); // no second reservation
    expect((await getSlot()).reserved).toBe(1);
  });

  it('timeout before the provider acted: reconciliation finds nothing and scheduling reopens', async () => {
    await toBookingRequested(new Driver(commands));
    sandbox.fault = 'TIMEOUT_BEFORE_COMMIT';
    await dispatcher.dispatchCase(T1, 'CL-1');
    await deliver();
    expect((await getCase()).bookingState).toBe('UNKNOWN');
    sandbox.fault = 'NONE';
    await pump();
    const c = await getCase();
    expect(c.bookingState).toBe('NONE');
    expect(c.automationPausedReason).toBeNull();
    expect(await reservations()).toHaveLength(0);
  });

  it('two cases racing for the last place in a slot: one confirmed, one rejected', async () => {
    const a = new Driver(commands, 'CL-A');
    const b = new Driver(commands, 'CL-B');
    await toBookingRequested(a, 'slot_1', { sourceId: 's1' });
    await toBookingRequested(b, 'slot_1', { sourceId: 's2' });
    await dispatcher.dispatchCase(T1, 'CL-A');
    await dispatcher.dispatchCase(T1, 'CL-B');
    const tasks = queue.drain().filter((t) => t.kind === 'BOOKING_REQUEST');
    await Promise.all(tasks.map((t) => runner.run(t.tenantId, t.outboxId)));
    const states = [
      (await getCase('CL-A')).bookingState,
      (await getCase('CL-B')).bookingState,
    ].sort();
    expect(states).toEqual(['CONFIRMED', 'NONE']);
    expect((await getSlot()).reserved).toBe(1);
    expect((await bookings()).map((x) => x.status).sort()).toEqual(['CONFIRMED', 'REJECTED']);
  });

  it('opt-out after the request: the worker re-checks and never reserves', async () => {
    const d = new Driver(commands);
    await toBookingRequested(d);
    d.track(await commands.optOut(coordinator, d.req({ channel: 'ALL' as const })));
    await pump();
    const c = await getCase();
    expect(c.bookingState).toBe('NONE');
    expect(c.outreachDisposition).toBe('OPTED_OUT');
    expect(await reservations()).toHaveLength(0);
  });

  it('retries end in a durable failure; an operator replay keeps the operation id and completes it', async () => {
    await toBookingRequested(new Driver(commands));
    sandbox.fault = 'TIMEOUT_AFTER_COMMIT';
    await dispatcher.dispatchCase(T1, 'CL-1');
    await deliver(); // reserve → UNKNOWN; the reconcile item is now PENDING
    sandbox.fault = 'NONE';
    sandbox.reconcileFails = true;
    const outcomes: RunResult[] = [];
    for (let i = 0; i < 3; i++) {
      await dispatcher.dispatchCase(T1, 'CL-1');
      const recon = (await outbox()).find((o) => o.kind === 'BOOKING_RECONCILE')!;
      outcomes.push(await runner.run(T1, recon.outboxId));
    }
    expect(outcomes.map((o) => o.status)).toEqual(['RETRY', 'RETRY', 'FAILED']);
    const recon = (await outbox()).find((o) => o.kind === 'BOOKING_RECONCILE')!;
    expect((await db.doc(tenantRecord(T1, 'failed_jobs', recon.outboxId)).get()).exists).toBe(true);
    expect((await getCase()).bookingState).toBe('UNKNOWN'); // still visible, never guessed

    sandbox.reconcileFails = false;
    expect(await runner.replay(T1, recon.outboxId, 'staff_owner')).toBe(true);
    queue.drain();
    await dispatcher.dispatchCase(T1, 'CL-1');
    const replayTask = queue.drain().find((t) => t.outboxId === recon.outboxId)!;
    expect(replayTask.name).toBe(`${recon.outboxId}-r1`);
    expect((await runner.run(T1, replayTask.outboxId)).status).toBe('DONE');
    expect((await getCase()).workflowState).toBe('BOOKED');
    expect((await db.doc(tenantRecord(T1, 'failed_jobs', recon.outboxId)).get()).exists).toBe(
      false,
    );
    expect(await reservations()).toHaveLength(1);
  });

  it('cancellation is pending until the adapter acknowledges, then frees the slot', async () => {
    const d = new Driver(commands);
    await toBookingRequested(d);
    await pump();
    const c = await getCase();
    d.version = c.version;
    const [b] = await bookings();
    const req = d.track(
      await commands.requestBookingCancellation(
        coordinator,
        d.req({ externalRef: b!.externalRef!, reason: 'Patient asked to cancel' }),
      ),
    );
    expect(req.bookingState).toBe('CONFIRMED');
    await pump();
    const after = await getCase();
    expect(after.bookingState).toBe('CANCELLED');
    expect(after.workflowState).toBe('AWAITING_BOOKING');
    expect((await getSlot()).reserved).toBe(0);
    expect((await bookings())[0]!.status).toBe('CANCELLED');
  });

  it('cancelling the case releases a confirmed reservation', async () => {
    const d = new Driver(commands);
    await toBookingRequested(d);
    await pump();
    d.version = (await getCase()).version;
    d.track(await commands.cancelCase(reviewer, d.req({ reason: 'Order withdrawn by clinic' })));
    await pump();
    expect((await getCase()).workflowState).toBe('CANCELLED');
    expect((await getSlot()).reserved).toBe(0);
    expect((await bookings())[0]!.status).toBe('CANCELLED');
  });

  it('manual adapter: a staff booking task, then staff enter the real reference', async () => {
    withAdapter(new ManualBookingAdapter());
    const d = new Driver(commands);
    await toBookingRequested(d);
    await pump();
    let c = await getCase();
    expect(c.workflowState).toBe('AWAITING_BOOKING');
    expect(c.bookingState).toBe('REQUESTED');
    expect((await bookings())[0]!.status).toBe('PENDING_STAFF');
    d.version = c.version;
    d.track(
      await commands.confirmBooking(
        coordinator,
        d.req({
          externalRef: 'CLINIC-REG-4471',
          startsAt: '2026-11-25T06:00:00.000Z',
          adapter: 'manual' as const,
          simulation: false,
        }),
      ),
    );
    c = await getCase();
    expect(c.workflowState).toBe('BOOKED');
  });
});
