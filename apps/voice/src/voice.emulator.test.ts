import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Case, type Slot } from '@careloop/contracts';
import { SandboxBookingAdapter } from '@careloop/adapters';
import {
  CaseCommands,
  consumeVoiceTicket,
  FirestoreStore,
  issueVoiceTicket,
  tenantRecord,
} from '@careloop/domain';
import { DEFAULT_CONFIG, Driver, seedWorld, START, T1 } from '@careloop/domain/testing';
import { createHandlers, JobRunner, MemoryQueue, OutboxDispatcher } from '@careloop/jobs';
import { createLogger } from '@careloop/observability';
import { VoiceSessionController, type ServerMessage } from './controller';
import type { LiveConnector, LiveEvents, LiveSession } from './live';
import { createVoiceServer } from './server';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) throw new Error('run via `pnpm test:emulator`');
const projectId = 'demo-careloop-voice';
const app = getApps()[0] ?? initializeApp({ projectId });
const db = getFirestore(app);

// Let in-flight background writes settle, then close gRPC streams so the emulator can shut down cleanly.
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await db.terminate();
});
const log = createLogger('voice-test');

/** Plays the model's side: the test injects tool calls and transcripts and reads what the gateway sent back. */
class ScriptedLive implements LiveConnector {
  events!: LiveEvents;
  texts: string[] = [];
  audioChunks = 0;
  closed = false;
  private waiters: ((r: Record<string, unknown>) => void)[] = [];
  connectError: Error | null = null;

  async connect(_o: unknown, events: LiveEvents): Promise<LiveSession> {
    if (this.connectError) throw this.connectError;
    this.events = events;
    return {
      sendAudio: () => void this.audioChunks++,
      sendText: (t) => void this.texts.push(t),
      sendToolResponses: (rs) => rs.forEach((r) => this.waiters.shift()?.(r.response)),
      close: () => void (this.closed = true),
    };
  }

  /** The model calls a tool; resolves with the gateway's tool response. */
  call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.events.onToolCalls([{ id: `call-${Math.random()}`, name, args }]);
    });
  }
}

const slot = (slotId: string, startsAt: string): Slot => ({
  slotId,
  siteId: 'site_1',
  actionType: 'CONSULTATION',
  location: 'Demo Clinic, Room 2',
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(),
  capacity: 1,
  reserved: 0,
});

describe('voice gateway (Firestore emulator)', () => {
  let now: Date;
  let commands: CaseCommands;
  let live: ScriptedLive;
  let sent: ServerMessage[];
  let worker: NodeJS.Timeout;
  let queue: MemoryQueue;
  let dispatcher: OutboxDispatcher;
  let booking: SandboxBookingAdapter;
  const clock = () => now;
  const getCase = async () =>
    (await db.doc(tenantRecord(T1, 'cases', 'CL-1')).get()).data() as Case;

  function controller(capSeconds = 170) {
    return new VoiceSessionController(
      {
        tenantId: T1,
        caseId: 'CL-1',
        interactionId: 'int_1',
        createdBy: 'u_coord',
        correlationId: 'corr',
        simulation: true,
        labName: 'Demo Lab',
        siteTimeZone: 'Asia/Kolkata',
      },
      {
        db,
        commands,
        booking,
        dispatcher,
        live,
        coordinationModel: null,
        models: { live: 'live-model', coordination: 'coord-model' },
        promptVersions: { conversation: 'conversation-v1', coordination: 'coordination-v1' },
        system: 'test',
        capSeconds,
        log,
        clock,
        bookingWaitMs: 4000,
      },
      (m) => sent.push(m),
    );
  }

  beforeEach(async () => {
    await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, {
      method: 'DELETE',
    });
    await seedWorld({ seed: (p, d) => db.doc(p).set(d) });
    await db
      .doc(tenantRecord(T1, 'slots', 's_morning'))
      .set(slot('s_morning', '2026-11-23T05:30:00.000Z'));
    await db
      .doc(tenantRecord(T1, 'slots', 's_evening'))
      .set(slot('s_evening', '2026-11-23T11:00:00.000Z'));
    now = new Date(START);
    commands = new CaseCommands({ store: new FirestoreStore(db), config: DEFAULT_CONFIG, clock });
    booking = new SandboxBookingAdapter(db, clock);
    queue = new MemoryQueue();
    dispatcher = new OutboxDispatcher(db, queue, log, { clock });
    const runner = new JobRunner(db, createHandlers({ db, commands, booking, log, clock }), log, {
      clock,
    });
    // A tiny in-test worker draining the queue, standing in for Cloud Tasks + the worker service.
    worker = setInterval(
      () => void Promise.all(queue.drain().map((t) => runner.run(t.tenantId, t.outboxId))),
      50,
    );
    live = new ScriptedLive();
    sent = [];
    const d = new Driver(commands);
    await d.create();
    await d.approve();
    await d.dispatch(); // CONTACTING
  });

  afterEach(() => clearInterval(worker));

  it('Phase 4 exit: a patient who can only come after work gets an offered evening slot booked, honestly reported', async () => {
    const c = controller();
    await c.start();
    expect(sent[0]).toMatchObject({ type: 'ready', simulation: true });

    // Before identity is confirmed, no details and no tools.
    expect(
      await live.call('find_slots', { preference: 'after 4 pm, I work until then' }),
    ).toMatchObject({ error: 'IDENTITY_NOT_VERIFIED' });
    await c.onClientMessage({ type: 'identity_verified' });

    const found = await live.call('find_slots', { preference: 'after 4 pm, I work until then' });
    expect(found.status).toBe('OK');
    const slots = found.slots as { slot_id: string }[];
    expect(slots[0]!.slot_id).toBe('s_evening');

    // An invented slot and an unconfirmed read-back are refused.
    expect(
      await live.call('request_booking', { slot_id: 'slot_made_up', patient_confirmed: true }),
    ).toMatchObject({ error: 'SLOT_NOT_OFFERED' });
    expect(
      await live.call('request_booking', { slot_id: 's_evening', patient_confirmed: false }),
    ).toMatchObject({ error: 'NOT_CONFIRMED' });

    const booked = await live.call('request_booking', {
      slot_id: 's_evening',
      patient_confirmed: true,
    });
    expect(booked.status).toBe('CONFIRMED');
    const caseAfter = await getCase();
    expect(caseAfter.workflowState).toBe('BOOKED');
    expect(caseAfter.evidenceState).toBe('NONE'); // booked is not completed

    now = new Date(now.getTime() + 95_000);
    await c.end('AGENT_ENDED');
    const interaction = (await db.doc(tenantRecord(T1, 'interactions', 'int_1')).get()).data()!;
    expect(interaction).toMatchObject({
      status: 'ENDED',
      disposition: 'BOOKED',
      identityAssurance: 'SIMULATED',
      audioSeconds: 95,
      unsupportedClaims: 0,
    });
    expect(interaction).not.toHaveProperty('transcript');
    expect((await getCase()).audioSecondsUsed).toBe(95);
    expect(sent.at(-1)).toMatchObject({ type: 'ended', disposition: 'BOOKED' });
  });

  it('MVP-06: a medical question is caught by the backstop even if the model would answer it', async () => {
    const c = controller();
    await c.start();
    await c.onClientMessage({ type: 'identity_verified' });
    await c.onClientMessage({
      type: 'text',
      text: 'Is my report serious? Should I take my medicine?',
    });
    // The patient's question is NOT forwarded; the model gets the approved-response instruction instead.
    expect(live.texts.some((t) => t.includes('Is my report serious'))).toBe(false);
    expect(live.texts.at(-1)).toContain("can't help with medical questions");
    const after = await getCase();
    expect(after.handoffState).toBe('PENDING');
    expect(after.automationPausedReason).toBe('HANDOFF');
    await c.end('AGENT_ENDED');
    const interaction = (await db.doc(tenantRecord(T1, 'interactions', 'int_1')).get()).data()!;
    expect(interaction.safetyEvents[0].kind).toBe('MEDICAL_QUESTION_BACKSTOP');
    expect(interaction.disposition).toBe('HANDED_TO_STAFF');
  });

  it('MVP-07: opt-out suppresses contact immediately; later tools are refused', async () => {
    const c = controller();
    await c.start();
    expect((await live.call('record_opt_out')).status).toBe('OPTED_OUT');
    expect((await getCase()).outreachDisposition).toBe('OPTED_OUT');
    expect(await live.call('find_slots', { preference: 'any' })).toMatchObject({
      error: 'PATIENT_OPTED_OUT',
    });
    await c.end('OPTED_OUT');
  });

  it('flags an agent that claims a booking before the calendar confirmed it', async () => {
    const c = controller();
    await c.start();
    live.events.onOutputTranscript('Great, your appointment is booked for Monday.');
    expect(sent.some((m) => m.type === 'event' && m.kind === 'qa')).toBe(true);
    await c.end('AGENT_ENDED');
    expect(
      (await db.doc(tenantRecord(T1, 'interactions', 'int_1')).get()).data()!.unsupportedClaims,
    ).toBe(1);
  });

  it('a call nobody answered records a retry and its billed seconds, not success', async () => {
    const c = controller();
    await c.start();
    now = new Date(now.getTime() + 20_000);
    await c.end('CLIENT_DISCONNECTED');
    const after = await getCase();
    expect(after.outreachDisposition).toBe('RETRY_SCHEDULED');
    expect(after.audioSecondsUsed).toBe(20);
    expect(after.workflowState).toBe('CONTACTING');
  });

  it('caps tool use: a looping model is stopped and the case goes to staff', async () => {
    const c = controller();
    await c.start();
    await c.onClientMessage({ type: 'identity_verified' });
    for (let i = 0; i < 8; i++) await live.call('find_slots', { preference: 'any' });
    expect(await live.call('find_slots', { preference: 'any' })).toMatchObject({
      error: 'TOOL_BUDGET_EXCEEDED',
    });
    expect((await getCase()).handoffState).toBe('PENDING');
    await c.end('AGENT_ENDED');
  });

  it('a model that never connects is not a call: no outcome, no billed audio, no event', async () => {
    live.connectError = new Error('Permission denied');
    const c = controller();
    const before = await getCase();
    await expect(c.start()).rejects.toThrow('Permission denied');
    await c.end('CONNECT_FAILED');
    const after = await getCase();
    expect(after.version).toBe(before.version);
    expect(after.outreachDisposition).toBe(before.outreachDisposition);
    expect((await db.doc(tenantRecord(T1, 'interactions', 'int_1')).get()).data()).toMatchObject({
      status: 'FAILED_TO_CONNECT',
    });
  });

  it('tickets are single-use and expire', async () => {
    const { ticket } = await issueVoiceTicket(
      db,
      { tenantId: T1, caseId: 'CL-1', interactionId: 'i', createdBy: 'u' },
      now,
    );
    expect(await consumeVoiceTicket(db, ticket, now)).toMatchObject({ caseId: 'CL-1' });
    expect(await consumeVoiceTicket(db, ticket, now)).toBeNull();
    const second = await issueVoiceTicket(
      db,
      { tenantId: T1, caseId: 'CL-1', interactionId: 'j', createdBy: 'u' },
      now,
    );
    expect(
      await consumeVoiceTicket(db, second.ticket, new Date(now.getTime() + 61_000)),
    ).toBeNull();
  });

  it('WebSocket: refuses foreign origins, requires the ticket as the first message, and starts a session', async () => {
    const cfg = loadConfig({
      INTAKE_MODEL_ID: 'a',
      COORDINATION_MODEL_ID: 'b',
      VERIFICATION_MODEL_ID: 'c',
      LIVE_MODEL_ID: 'd',
      VOICE_ALLOWED_ORIGINS: 'http://localhost:3000',
    });
    const runtime = { commands, booking, dispatcher } as never;
    const { server } = createVoiceServer({ cfg, db, live, coordinationModel: null, log, runtime });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}/v1/voice/connect`;
    try {
      const refused = await new Promise<string>((resolve) => {
        const ws = new WebSocket(url, { origin: 'https://evil.example' });
        ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
        ws.on('open', () => resolve('opened'));
      });
      expect(refused).toBe('403');

      const bad = await new Promise<string>((resolve) => {
        const ws = new WebSocket(url, { origin: 'http://localhost:3000' });
        ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', ticket: 'x'.repeat(43) })));
        ws.on('message', (d) => resolve(JSON.parse(String(d)).type));
      });
      expect(bad).toBe('error');

      const { ticket } = await issueVoiceTicket(db, {
        tenantId: T1,
        caseId: 'CL-1',
        interactionId: 'int_ws',
        createdBy: 'u_coord',
      });
      const first = await new Promise<ServerMessage>((resolve) => {
        const ws = new WebSocket(url, { origin: 'http://localhost:3000' });
        ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', ticket })));
        ws.on('message', (d) => {
          resolve(JSON.parse(String(d)));
          ws.close();
        });
      });
      expect(first).toMatchObject({ type: 'ready', simulation: true });
    } finally {
      server.close();
    }
  });
});
