import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { Case, EventEnvelope, Slot, SupportedLanguage } from '@careloop/contracts';
import { SandboxBookingAdapter } from '@careloop/adapters';
import { ScriptedJsonModel, type JsonModel } from '@careloop/ai';
import {
  CaseCommands,
  FirestoreStore,
  tenantCollection,
  tenantRecord,
  caseEvents,
  type EvidenceDoc,
  type HandoffDoc,
} from '@careloop/domain';
import {
  DEFAULT_CONFIG,
  Driver,
  patient,
  consent,
  seedWorld,
  START,
  T1,
} from '@careloop/domain/testing';
import {
  createHandlers,
  ingestProviderWebhook,
  JobRunner,
  MemoryQueue,
  OutboxDispatcher,
  signSandboxPayload,
  TimeSweeps,
} from '@careloop/jobs';
import { createLogger } from '@careloop/observability';
import { VoiceSessionController, type ServerMessage } from '@careloop/voice/controller';
import type { LiveConnector, LiveEvents, LiveSession } from '@careloop/voice/live';

const log = createLogger('evals');
log.info = () => undefined; // keep the report output readable
log.warn = () => undefined;

let db: Firestore | undefined;
export function emulatorDb(projectId: string): Firestore {
  if (!process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('Run evals via `pnpm eval` (Firestore emulator required)');
  if (!db) db = getFirestore(getApps()[0] ?? initializeApp({ projectId }));
  return db;
}

/**
 * Plays the conversation model. Scenarios script it, including deliberately
 * non-compliant moves (inventing slots, claiming a booking, answering medical
 * questions) so the eval measures what the system enforces regardless of the
 * model's behaviour.
 */
export class ScriptedLive implements LiveConnector {
  events!: LiveEvents;
  texts: string[] = [];
  private waiters: ((r: Record<string, unknown>) => void)[] = [];
  async connect(_o: unknown, events: LiveEvents): Promise<LiveSession> {
    this.events = events;
    return {
      sendAudio: () => undefined,
      sendText: (t) => void this.texts.push(t),
      sendToolResponses: (rs) => rs.forEach((r) => this.waiters.shift()?.(r.response)),
      close: () => undefined,
    };
  }
  call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.events.onToolCalls([{ id: `c-${Math.random()}`, name, args }]);
    });
  }
  say(text: string) {
    this.events.onOutputTranscript(text);
  }
}

export interface VoiceRig {
  controller: VoiceSessionController;
  live: ScriptedLive;
  sent: ServerMessage[];
  patientSays(text: string): Promise<void>;
  verifyIdentity(): Promise<void>;
  end(reason?: string): Promise<void>;
}

export const SLOT_TIMES = {
  morning: '2026-11-23T05:30:00.000Z', // 11:00 IST
  evening: '2026-11-23T11:00:00.000Z', // 16:30 IST
  late: '2026-11-23T12:30:00.000Z', // 18:00 IST
};

export class World {
  now: Date = new Date(START);
  readonly clock = () => this.now;
  readonly commands: CaseCommands;
  readonly sandbox: SandboxBookingAdapter;
  readonly queue = new MemoryQueue();
  readonly dispatcher: OutboxDispatcher;
  readonly runner: JobRunner;
  readonly sweeps: TimeSweeps;
  coordinationModel: JsonModel | null = null;

  constructor(
    readonly db: Firestore,
    readonly language: SupportedLanguage,
  ) {
    this.commands = new CaseCommands({
      store: new FirestoreStore(db),
      config: DEFAULT_CONFIG,
      clock: this.clock,
    });
    this.sandbox = new SandboxBookingAdapter(db, this.clock);
    this.dispatcher = new OutboxDispatcher(db, this.queue, log, { clock: this.clock });
    this.runner = new JobRunner(
      db,
      createHandlers({
        db,
        commands: this.commands,
        booking: this.sandbox,
        log,
        clock: this.clock,
      }),
      log,
      { clock: this.clock },
    );
    this.sweeps = new TimeSweeps(db, this.commands, log, { clock: this.clock });
  }

  /** Patient for this language: p1 speaks Hindi, p_en English. */
  get patientId() {
    return this.language === 'hi-IN' ? 'p1' : 'p_en';
  }
  get consentId() {
    return this.language === 'hi-IN' ? 'c1' : 'c_en';
  }
  get patientRef() {
    return `ref_${this.patientId}`;
  }

  static async create(
    db: Firestore,
    projectId: string,
    language: SupportedLanguage,
    slots: (keyof typeof SLOT_TIMES)[] = ['morning', 'evening', 'late'],
  ) {
    await fetch(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
      { method: 'DELETE' },
    );
    await seedWorld({ seed: (p, d) => db.doc(p).set(d) });
    await db.doc(tenantRecord(T1, 'patients', 'p_en')).set(patient('p_en', { language: 'en-IN' }));
    await db.doc(tenantRecord(T1, 'consents', 'c_en')).set(consent('c_en', 'p_en'));
    await db.doc('provider_accounts/sandbox__eval-cal').set({ tenantId: T1, active: true });
    for (const k of slots) {
      const s: Slot = {
        slotId: `s_${k}`,
        siteId: 'site_1',
        actionType: 'CONSULTATION',
        location: 'Demo Clinic, Room 2',
        startsAt: SLOT_TIMES[k],
        endsAt: new Date(Date.parse(SLOT_TIMES[k]) + 1_800_000).toISOString(),
        capacity: 1,
        reserved: 0,
      };
      await db.doc(tenantRecord(T1, 'slots', s.slotId)).set(s);
    }
    return new World(db, language);
  }

  driver(caseId = 'CL-1') {
    const d = new Driver(this.commands, caseId);
    const create = d.create.bind(d);
    d.create = (over = {}) =>
      create({
        patientId: this.patientId,
        consentId: this.consentId,
        language: this.language,
        ...over,
      });
    return d;
  }

  /** Dispatch outbox items and run them until quiet, like the queue + worker would. */
  async pump(caseId = 'CL-1') {
    for (let i = 0; i < 8; i++) {
      await this.dispatcher.dispatchCase(T1, caseId);
      const tasks = this.queue.drain();
      if (!tasks.length) return;
      for (const t of tasks) await this.runner.run(t.tenantId, t.outboxId);
    }
  }

  async voice(caseId = 'CL-1'): Promise<VoiceRig> {
    const live = new ScriptedLive();
    const sent: ServerMessage[] = [];
    const interactionId = `int_${Math.random().toString(36).slice(2, 10)}`;
    const controller = new VoiceSessionController(
      {
        tenantId: T1,
        caseId,
        interactionId,
        createdBy: 'u_coord',
        correlationId: 'eval',
        simulation: true,
        labName: 'Demo Lab',
        siteTimeZone: 'Asia/Kolkata',
      },
      {
        db: this.db,
        commands: this.commands,
        booking: this.sandbox,
        dispatcher: this.dispatcher,
        live,
        coordinationModel: this.coordinationModel,
        models: { live: 'scripted-live', coordination: 'scripted' },
        promptVersions: { conversation: 'conversation-v1', coordination: 'coordination-v1' },
        system: 'eval',
        capSeconds: 170,
        log,
        clock: this.clock,
        bookingWaitMs: 50,
      },
      (m) => sent.push(m),
    );
    await controller.start();
    return {
      controller,
      live,
      sent,
      patientSays: (text) => controller.onClientMessage({ type: 'text', text }),
      verifyIdentity: () => controller.onClientMessage({ type: 'identity_verified' }),
      end: (reason = 'AGENT_ENDED') => controller.end(reason),
    };
  }

  /** request_booking returns before the worker runs; run the worker and ask again for the honest status. */
  async bookViaVoice(v: VoiceRig, slotId: string) {
    const first = await v.live.call('request_booking', {
      slot_id: slotId,
      patient_confirmed: true,
    });
    await this.pump();
    return first;
  }

  async getCase(id = 'CL-1') {
    return (await this.db.doc(tenantRecord(T1, 'cases', id)).get()).data() as Case;
  }
  async events(id = 'CL-1') {
    return (await this.db.collection(caseEvents(T1, id)).get()).docs
      .map((d) => d.data() as EventEnvelope)
      .sort((a, b) => (a.nextVersion ?? 0) - (b.nextVersion ?? 0));
  }
  async evidence(id = 'CL-1') {
    return (
      await this.db.collection(tenantCollection(T1, 'evidence')).where('caseId', '==', id).get()
    ).docs.map((d) => d.data() as EvidenceDoc);
  }
  async handoff(id = 'CL-1') {
    const c = await this.getCase(id);
    return c.activeHandoffId
      ? ((
          await this.db.doc(tenantRecord(T1, 'handoffs', c.activeHandoffId)).get()
        ).data() as HandoffDoc)
      : null;
  }

  /** Sends a signed sandbox-calendar event through the real webhook path. */
  async providerEvent(e: Record<string, unknown>) {
    const secret = 'eval-webhook-secret-000001';
    const raw = JSON.stringify({
      sourceSystem: 'sandbox_calendar',
      receivedAt: this.now.toISOString(),
      simulation: true,
      ...e,
    });
    const r = await ingestProviderWebhook(
      {
        db: this.db,
        secrets: { 'sandbox:eval-cal': secret },
        dispatcher: this.dispatcher,
        log,
        clock: this.clock,
      },
      {
        provider: 'sandbox',
        account: 'eval-cal',
        rawBody: raw,
        signature: signSandboxPayload(secret, Math.floor(this.now.getTime() / 1000), raw),
      },
    );
    await this.pump(String(e.caseId ?? 'CL-1'));
    return r;
  }

  scriptedCoordination(fn: (user: string) => unknown) {
    this.coordinationModel = new ScriptedJsonModel((call) => fn(call.user));
  }
}

export class CheckFailure extends Error {}
export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new CheckFailure(message);
}
