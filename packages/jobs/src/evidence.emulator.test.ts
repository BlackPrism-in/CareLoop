import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Case, Slot } from '@careloop/contracts';
import { SandboxBookingAdapter } from '@careloop/adapters';
import {
  CaseCommands,
  FirestoreStore,
  tenantCollection,
  tenantDoc,
  tenantRecord,
  type HandoffDoc,
} from '@careloop/domain';
import { AGENT, DEFAULT_CONFIG, Driver, seedWorld, START, T1 } from '@careloop/domain/testing';
import { createLogger } from '@careloop/observability';
import { OutboxDispatcher } from './dispatcher';
import { createHandlers } from './handlers';
import { MemoryQueue } from './queue';
import { JobRunner } from './runner';
import { TimeSweeps } from './sweeps';
import { ingestProviderWebhook, signSandboxPayload, type InboxDoc } from './webhooks';

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
const log = createLogger('evidence-test');
const SECRET = 'test-webhook-secret-123456';
const secrets = { 'sandbox:cal': SECRET };

describe('provider webhooks, evidence and time sweeps (Firestore emulator)', () => {
  let now: Date;
  let commands: CaseCommands;
  let queue: MemoryQueue;
  let dispatcher: OutboxDispatcher;
  let runner: JobRunner;
  const clock = () => now;
  const getCase = async () =>
    (await db.doc(tenantRecord(T1, 'cases', 'CL-1')).get()).data() as Case;

  async function pump() {
    for (let i = 0; i < 6; i++) {
      await dispatcher.dispatchCase(T1, 'CL-1');
      const tasks = queue.drain();
      if (!tasks.length) break;
      for (const t of tasks) await runner.run(t.tenantId, t.outboxId);
    }
  }

  function post(event: Record<string, unknown>, opts: { secret?: string; at?: Date } = {}) {
    const raw = JSON.stringify(event);
    const ts = Math.floor((opts.at ?? now).getTime() / 1000);
    return ingestProviderWebhook(
      { db, secrets, dispatcher, log, clock },
      {
        provider: 'sandbox',
        account: 'cal',
        rawBody: raw,
        signature: signSandboxPayload(opts.secret ?? SECRET, ts, raw),
      },
    );
  }

  const attended = async (o: Record<string, unknown> = {}) => {
    const c = await getCase();
    return {
      eventId: `evt_${Math.random().toString(36).slice(2)}`,
      eventType: 'APPOINTMENT_ATTENDED',
      sourceSystem: 'sandbox_calendar',
      externalBookingRef: c.bookingRef,
      patientExternalRef: 'ref_p1',
      occurredAt: '2026-11-23T11:05:00.000Z',
      receivedAt: '2026-11-23T11:05:08.000Z',
      simulation: true,
      ...o,
    };
  };

  beforeEach(async () => {
    await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, {
      method: 'DELETE',
    });
    await seedWorld({ seed: (p, d) => db.doc(p).set(d) });
    const slot: Slot = {
      slotId: 'slot_1',
      siteId: 'site_1',
      actionType: 'CONSULTATION',
      location: 'Room 2',
      startsAt: '2026-11-23T11:00:00.000Z',
      endsAt: '2026-11-23T11:30:00.000Z',
      capacity: 1,
      reserved: 0,
    };
    await db.doc(tenantRecord(T1, 'slots', 'slot_1')).set(slot);
    await db.doc('provider_accounts/sandbox__cal').set({ tenantId: T1, active: true });
    now = new Date(START);
    commands = new CaseCommands({ store: new FirestoreStore(db), config: DEFAULT_CONFIG, clock });
    queue = new MemoryQueue();
    dispatcher = new OutboxDispatcher(db, queue, log, { clock });
    runner = new JobRunner(
      db,
      createHandlers({ db, commands, booking: new SandboxBookingAdapter(db, clock), log, clock }),
      log,
      { clock },
    );
    const d = new Driver(commands);
    await d.create();
    await d.approve();
    await d.dispatch();
    await d.patientBooks();
    await d.requestBooking('slot_1');
    await pump(); // BOOKED via the sandbox
    now = new Date('2026-11-23T12:00:00.000Z');
  });

  it('rejects bad signatures, stale timestamps and unknown accounts before touching data', async () => {
    const ev = await attended();
    expect((await post(ev, { secret: 'wrong-secret-0000000000' })).reason).toBe('SIGNATURE_BAD');
    expect((await post(ev, { at: new Date(now.getTime() - 10 * 60_000) })).reason).toBe(
      'SIGNATURE_STALE',
    );
    const raw = JSON.stringify(ev);
    const unknown = await ingestProviderWebhook(
      { db, secrets, dispatcher, log, clock },
      {
        provider: 'sandbox',
        account: 'other',
        rawBody: raw,
        signature: signSandboxPayload(SECRET, Math.floor(now.getTime() / 1000), raw),
      },
    );
    expect(unknown.httpStatus).toBe(404);
    expect((await db.collection(tenantCollection(T1, 'inbox')).get()).size).toBe(0);
  });

  it('a signed, matching attendance event completes the case once; a repeat delivery is a duplicate', async () => {
    const ev = await attended();
    expect(await post(ev)).toMatchObject({ httpStatus: 202, status: 'ACCEPTED' });
    expect(await post(ev)).toMatchObject({ httpStatus: 200, status: 'DUPLICATE' });
    await pump();
    const c = await getCase();
    expect(c.workflowState).toBe('COMPLETED_VERIFIED');
    const evidence = (await db.collection(tenantCollection(T1, 'evidence')).get()).docs.map((d) =>
      d.data(),
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      kind: 'PROVIDER_EVENT',
      status: 'VERIFIED',
      simulation: true,
      issuer: 'sandbox:cal',
    });
    const inbox = (
      await db.collection(tenantCollection(T1, 'inbox')).get()
    ).docs[0]!.data() as InboxDoc;
    expect(inbox.status).toBe('PROCESSED');
  });

  it('demo step: a mismatched completion record is rejected with its reason; the matching one is then accepted', async () => {
    await post(await attended({ patientExternalRef: 'ref_someone_else' }));
    await pump();
    let c = await getCase();
    expect(c.workflowState).toBe('BOOKED');
    expect(c.evidenceState).toBe('REJECTED');
    const rejected = (await db.collection(tenantCollection(T1, 'evidence')).get()).docs[0]!.data();
    expect(rejected).toMatchObject({ status: 'REJECTED', reasons: ['PATIENT_REF_MISMATCH'] });
    await post(await attended());
    await pump();
    c = await getCase();
    expect(c.workflowState).toBe('COMPLETED_VERIFIED');
  });

  it('a provider cancellation applies once; an older out-of-order event cannot resurrect anything', async () => {
    const c = await getCase();
    const base = {
      sourceSystem: 'sandbox_calendar',
      externalBookingRef: c.bookingRef,
      patientExternalRef: 'ref_p1',
      occurredAt: '2026-11-23T10:00:00.000Z',
      receivedAt: '2026-11-23T10:00:01.000Z',
      simulation: true,
    };
    await post({
      ...base,
      eventId: 'e-cancel',
      eventType: 'APPOINTMENT_CANCELLED',
      sourceSequence: 5,
    });
    await pump();
    expect((await getCase()).bookingState).toBe('CANCELLED');
    await post({
      ...base,
      eventId: 'e-old-confirm',
      eventType: 'APPOINTMENT_CONFIRMED',
      sourceSequence: 3,
    });
    await pump();
    const after = await getCase();
    expect(after.bookingState).toBe('CANCELLED');
    const statuses = (await db.collection(tenantCollection(T1, 'inbox')).get()).docs
      .map((d) => (d.data() as InboxDoc).status)
      .sort();
    expect(statuses).toEqual(['PROCESSED', 'STALE']);
  });

  it('an event that matches no case stays visible as UNMATCHED and changes nothing', async () => {
    const r = await post({
      eventId: 'e-x',
      eventType: 'APPOINTMENT_ATTENDED',
      sourceSystem: 's',
      externalBookingRef: 'sbx_unknown',
      patientExternalRef: 'ref_nobody',
      occurredAt: '2026-11-23T11:00:00.000Z',
      receivedAt: '2026-11-23T11:00:00.000Z',
      simulation: true,
    });
    expect(r.status).toBe('UNMATCHED');
    expect((await getCase()).workflowState).toBe('BOOKED');
  });

  it('time sweep: a passed appointment moves to AWAITING_EVIDENCE, never to completed', async () => {
    const r = await new TimeSweeps(db, commands, log, { clock }).run();
    expect(r.awaitingEvidence).toBe(1);
    const c = await getCase();
    expect(c.workflowState).toBe('AWAITING_EVIDENCE');
    expect(c.evidenceState).toBe('NONE');
  });

  it('time sweep: an unacknowledged overdue handoff notifies backup staff once, only in staffed hours', async () => {
    const d = new Driver(commands);
    d.version = (await getCase()).version;
    now = new Date('2026-11-23T06:00:00.000Z'); // 11:30 IST
    await commands.createHandoff(
      AGENT,
      d.req({
        reasonCode: 'MEDICAL_QUESTION',
        ownerId: 'u_coord',
        dueAt: '2026-11-23T07:00:00.000Z',
      }),
    );
    await pump();
    const assigned = (await db.collection(tenantCollection(T1, 'notifications')).get()).docs.map(
      (x) => x.data(),
    );
    expect(assigned).toEqual([
      expect.objectContaining({ kind: 'HANDOFF_ASSIGNED', recipientId: 'u_coord' }),
    ]);

    const sweeps = new TimeSweeps(db, commands, log, { clock });
    now = new Date('2026-11-23T16:00:00.000Z'); // 21:30 IST — overdue but outside staffed hours
    expect((await sweeps.run()).backupNotified).toBe(0);
    now = new Date('2026-11-24T04:00:00.000Z'); // 09:30 IST next day
    expect((await sweeps.run()).backupNotified).toBe(1);
    expect((await sweeps.run()).backupNotified).toBe(0); // only once
    const c = await getCase();
    const h = (
      await db.doc(tenantRecord(T1, 'handoffs', c.activeHandoffId!)).get()
    ).data() as HandoffDoc;
    expect(h.backupNotifiedAt).toBeTruthy();
    const overdue = (
      await db
        .collection(tenantCollection(T1, 'notifications'))
        .where('kind', '==', 'HANDOFF_OVERDUE')
        .get()
    ).docs
      .map((x) => x.data().recipientId)
      .sort();
    expect(overdue).toEqual(['u_owner', 'u_rev']);
  });

  it('booking worker re-checks consent: revoked after the request means no reservation', async () => {
    // Fresh case on another source so it is independent of the booked one.
    const d2 = new Driver(commands, 'CL-2');
    now = new Date(START);
    await d2.create({ sourceId: 's2' });
    await d2.approve();
    await d2.dispatch();
    await d2.patientBooks();
    await db.doc(tenantRecord(T1, 'slots', 'slot_2')).set({
      slotId: 'slot_2',
      siteId: 'site_1',
      actionType: 'CONSULTATION',
      location: 'Room 2',
      startsAt: '2026-11-24T11:00:00.000Z',
      endsAt: '2026-11-24T11:30:00.000Z',
      capacity: 1,
      reserved: 0,
    });
    await d2.requestBooking('slot_2');
    await db
      .doc(tenantRecord(T1, 'consents', 'c1'))
      .update({ revokedAt: now.toISOString(), version: 2 });
    for (let i = 0; i < 4; i++) {
      await dispatcher.dispatchCase(T1, 'CL-2');
      for (const t of queue.drain()) await runner.run(t.tenantId, t.outboxId);
    }
    const c2 = (await db.doc(tenantRecord(T1, 'cases', 'CL-2')).get()).data() as Case;
    expect(c2.bookingState).toBe('NONE');
    expect((await db.doc(tenantRecord(T1, 'slots', 'slot_2')).get()).data()!.reserved).toBe(0);
    expect((await db.doc(tenantDoc(T1)).get()).exists).toBe(true);
  });

  it('retention: removes expired credentials and old operational records, keeps case evidence', async () => {
    const old = '2026-09-01T00:00:00.000Z';
    await db.doc('voice_tickets/old').set({ expiresAt: old });
    await db.doc('patient_sessions/old').set({ expiresAt: old });
    await db.doc('patient_links/live').set({ expiresAt: '2027-01-01T00:00:00.000Z' });
    await db.doc(tenantRecord(T1, 'notifications', 'old')).set({ createdAt: old });
    await db.doc(tenantRecord(T1, 'inbox', 'old')).set({ receivedAt: old });
    const evidenceBefore = (await db.collection(tenantCollection(T1, 'evidence')).get()).size;
    const n = await new TimeSweeps(db, commands, log, { clock }).retention();
    expect(n).toBeGreaterThanOrEqual(4);
    expect((await db.doc('voice_tickets/old').get()).exists).toBe(false);
    expect((await db.doc('patient_sessions/old').get()).exists).toBe(false);
    expect((await db.doc('patient_links/live').get()).exists).toBe(true);
    expect((await db.doc(tenantRecord(T1, 'inbox', 'old')).get()).exists).toBe(false);
    expect((await db.collection(tenantCollection(T1, 'evidence')).get()).size).toBe(evidenceBefore);
    expect((await getCase()).workflowState).toBe('BOOKED');
  });
});
