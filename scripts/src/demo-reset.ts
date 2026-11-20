import type { Consent, Site, Source, SupportedLanguage, ActionType } from '@careloop/contracts';
import { SandboxBookingAdapter } from '@careloop/adapters';
import {
  CaseCommands,
  FirestoreStore,
  setPatientWhatsApp,
  tenantCollection,
  tenantDoc,
  type PatientContactDoc,
  tenantRecord,
  type ActorContext,
} from '@careloop/domain';
import { createHandlers, JobRunner, MemoryQueue, OutboxDispatcher } from '@careloop/jobs';
import { createLogger } from '@careloop/observability';
import { demoTarget, seedBase, seedLogins } from './seed-lib';

/**
 * Resets the demo lab to the exact starting state of the 3-minute demo
 * (docs/DEMO.md). Synthetic data only. Runs on the emulator by default, or on a
 * deployed demo/staging project with `--project <id> --confirm <id>` (staff
 * logins there come from `bootstrap:staging`).
 */
const { projectId, db, emulator } = demoTarget();
const log = createLogger('demo-reset');
log.info = () => undefined;

const DEMO_TENANT = 't_demo_siliguri';
// Testers' WhatsApp numbers linked to synthetic patients survive a reset.
const linked = emulator
  ? []
  : (await db.collection(tenantCollection(DEMO_TENANT, 'patient_contacts')).get()).docs.map(
      (d) => d.data() as PatientContactDoc,
    );
if (emulator) {
  await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
} else {
  // Only the synthetic demo lab is removed; nothing else in the project is touched.
  await db.recursiveDelete(db.doc(tenantDoc(DEMO_TENANT)));
}
const bundle = await seedBase(db, { includeCases: false });
if (bundle.tenant.tenantId !== DEMO_TENANT) throw new Error('fixture tenant changed');
if (emulator) await seedLogins(bundle);
const t = bundle.tenant.tenantId;
for (const l of linked) {
  await setPatientWhatsApp(db, { tenantId: t, patientId: l.patientId }, l.phoneE164, 'demo-reset');
  for (const d of (
    await db.collection(tenantCollection(t, 'consents')).where('patientId', '==', l.patientId).get()
  ).docs) {
    const k = d.data() as Consent;
    if (!k.channels.includes('WHATSAPP'))
      await d.ref.update({ channels: [...k.channels, 'WHATSAPP'], version: k.version + 1 });
  }
}
if (linked.length) console.log(`Kept ${linked.length} linked WhatsApp test number(s).`);

// Contact hours are enforced. If you rehearse outside 09:00–19:00 IST, widen them for the demo lab only.
const hourIst = Number(
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date()),
);
if (hourIst < 9 || hourIst >= 19) {
  const site = bundle.sites[0]!;
  await db
    .doc(tenantRecord(t, 'sites', site.siteId))
    .set({ ...site, contactWindow: { start: '00:00', end: '23:59' } } satisfies Site);
  console.log(
    'Note: outside 09:00–19:00 IST — widened the demo lab contact window to 00:00–23:59.',
  );
}
const extraSource: Source = {
  sourceId: 'src_demo_05',
  sourceAuthority: 'demo_clinic',
  documentType: 'FORM',
  reference: 'order_demo_05',
};
await db.doc(tenantRecord(t, 'sources', extraSource.sourceId)).set(extraSource);

const commands = new CaseCommands({
  store: new FirestoreStore(db),
  config: { outreachEnabled: false, maxContactAttempts: 2, maxCaseAudioSeconds: 180 },
});
const queue = new MemoryQueue();
const dispatcher = new OutboxDispatcher(db, queue, log);
const runner = new JobRunner(
  db,
  createHandlers({ db, commands, booking: new SandboxBookingAdapter(db), log }),
  log,
);
const ctx = (uid: string, ...roles: ActorContext['roles'][number][]): ActorContext => ({
  tenantId: t,
  actorType: 'STAFF',
  actorId: uid,
  roles,
  correlationId: `demo-reset-${uid}`,
});
const coord = ctx('staff_demo_01', 'COORDINATOR');
const rev = ctx('staff_demo_reviewer', 'REVIEWER');
const agent: ActorContext = {
  tenantId: t,
  actorType: 'AGENT',
  actorId: 'demo-reset',
  roles: [],
  correlationId: 'demo-reset',
};
const DAY = 86_400_000;

async function stage(
  o: {
    caseId: string;
    patientId: string;
    consentId: string;
    sourceId: string;
    actionType: ActionType;
    actionText: string;
    language: SupportedLanguage;
    dueDays: number;
  },
  steps: ('approve' | 'contact' | 'book')[],
) {
  let v = (
    await commands.createCase(coord, {
      idempotencyKey: `demo-${o.caseId}`,
      input: {
        caseId: o.caseId,
        siteId: 'site_demo_main',
        patientId: o.patientId,
        sourceId: o.sourceId,
        consentId: o.consentId,
        actionType: o.actionType,
        actionText: o.actionText,
        dueAt: new Date(Date.now() + o.dueDays * DAY).toISOString(),
        ownerId: 'staff_demo_01',
        language: o.language,
      },
    })
  ).version;
  const base = (k: string) => ({
    caseId: o.caseId,
    expectedVersion: v,
    idempotencyKey: `demo-${o.caseId}-${k}`,
  });
  if (steps.includes('approve'))
    v = (
      await commands.approve(rev, {
        ...base('approve'),
        input: {
          sourceAuthorityRef: o.sourceId,
          checkedFields: ['patient', 'action', 'dueAt', 'contact', 'owner', 'language', 'adult'],
        },
      })
    ).version;
  if (steps.includes('contact'))
    v = (
      await commands.dispatchContact(coord, {
        ...base('contact'),
        input: { channel: 'BROWSER_VOICE' },
      })
    ).version;
  if (steps.includes('book')) {
    v = (
      await commands.recordPatientRequest(agent, {
        ...base('ask'),
        input: { interactionId: 'demo-reset', identityAssurance: 'SIMULATED', request: 'BOOK' },
      })
    ).version;
    await commands.requestBooking(agent, {
      ...base('book'),
      input: { slotId: 'slot_demo_t1', patientConfirmedSlot: true },
    });
    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatchCase(t, o.caseId);
      const tasks = queue.drain();
      if (!tasks.length) break;
      for (const task of tasks) await runner.run(task.tenantId, task.outboxId);
    }
  }
}

await stage(
  {
    caseId: 'CL-2001',
    patientId: 'pat_demo_01',
    consentId: 'consent_demo_01',
    sourceId: 'src_demo_01',
    actionType: 'CONSULTATION',
    actionText: 'Arrange the approved clinic consultation',
    language: 'hi-IN',
    dueDays: 4,
  },
  ['approve', 'contact'],
);
await stage(
  {
    caseId: 'CL-2002',
    patientId: 'pat_demo_02',
    consentId: 'consent_demo_02',
    sourceId: 'src_demo_02',
    actionType: 'ORDERED_TEST',
    actionText: 'Schedule the already-ordered repeat test collection',
    language: 'en-IN',
    dueDays: 5,
  },
  ['approve', 'contact', 'book'],
);
await stage(
  {
    caseId: 'CL-2003',
    patientId: 'pat_demo_01',
    consentId: 'consent_demo_01',
    sourceId: 'src_demo_05',
    actionType: 'ORDERED_TEST',
    actionText: 'Schedule the already-ordered sample collection',
    language: 'hi-IN',
    dueDays: 6,
  },
  ['approve', 'contact'],
);
await stage(
  {
    caseId: 'CL-2004',
    patientId: 'pat_demo_02',
    consentId: 'consent_demo_02',
    sourceId: 'src_demo_03',
    actionType: 'CONSULTATION',
    actionText: 'Arrange the approved clinic consultation',
    language: 'en-IN',
    dueDays: 7,
  },
  [],
);
await stage(
  {
    caseId: 'CL-2005',
    patientId: 'pat_demo_04',
    consentId: 'consent_demo_04',
    sourceId: 'src_demo_04',
    actionType: 'ORDERED_TEST',
    actionText: 'Schedule the already-ordered sample collection',
    language: 'en-IN',
    dueDays: 7,
  },
  [],
);

const booked = (await db.doc(tenantRecord(t, 'cases', 'CL-2002')).get()).data();
console.log(`Demo reset (synthetic data, ${projectId}):
  CL-2004  Draft, approvable          → 0:00 intake review + approval
  CL-2005  Draft, adult not confirmed → approval is blocked (optional)
  CL-2001  Contacting (Hindi)         → 0:25 live call: "can't come during work hours"
  CL-2002  ${booked?.workflowState} (${booked?.bookingRef ?? 'no ref'}) → 1:45 evidence: mismatched, then matching
  CL-2003  Contacting (Hindi)         → 2:15 medical question / opt-out
Sign in ${emulator ? 'at http://localhost:3000 with the demo accounts in docs/PHASE2.md' : 'with the bootstrap:staging logins (.env.staging.local)'}.`);
process.exit(0);
