import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from 'firebase-admin/auth';
import type { Consent, Member, Patient, Site, Source, Tenant } from '@careloop/contracts';
import {
  CaseCommands,
  FirestoreStore,
  tenantDoc,
  tenantRecord,
  type ActorContext,
} from '@careloop/domain';
import { adminApp, firestore } from '@/server/firebase';

/**
 * Tenant-isolation sweep (MVP spec §19 "test every endpoint with cross-tenant
 * references"). Every staff route is called by a member of lab B holding every
 * staff role, aimed at real ids from lab A, with a body that passes
 * validation. Id-targeted routes must refuse; list routes may answer but must
 * contain nothing from lab A; lab A's data must be unchanged afterwards.
 */
const PROJECT = 'demo-careloop-api';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST!;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST!;
const A = 't_iso_a';
const B = 't_iso_b';
const PASSWORD = 'isolation-test-pass';

const modules = import.meta.glob('../app/**/route.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;
const ids: Record<string, string> = {};
let tokenB = '';
let tokenNorth = '';

const tenant = (tenantId: string, displayName: string): Tenant => ({
  tenantId,
  displayName,
  timeZone: 'Asia/Kolkata',
  outreachPaused: false,
  simulation: true,
});
const site: Site = {
  siteId: 'site_iso',
  displayName: 'Iso site',
  timeZone: 'Asia/Kolkata',
  contactWindow: { start: '00:00', end: '23:59' },
};
const member = (uid: string): Member => ({
  uid,
  displayName: uid,
  email: `${uid}@iso.careloop.test`,
  roleSet: ['OWNER', 'REVIEWER', 'COORDINATOR', 'VERIFIER'],
  status: 'ACTIVE',
  permittedSiteIds: ['site_iso'],
});

async function snapshotA() {
  const db = firestore();
  const read = async (p: string) => JSON.stringify((await db.doc(p).get()).data() ?? null);
  return {
    tenant: await read(tenantDoc(A)),
    case: await read(tenantRecord(A, 'cases', ids.caseId!)),
    consent: await read(tenantRecord(A, 'consents', 'consent_a')),
    evidence: await read(tenantRecord(A, 'evidence', ids.evidenceId!)),
    handoff: await read(tenantRecord(A, 'handoffs', ids.handoffId!)),
    booking: await read(tenantRecord(A, 'bookings', ids.bookingId!)),
    failed: await read(tenantRecord(A, 'failed_jobs', ids.jobId!)),
    patient: await read(tenantRecord(A, 'patients', 'pat_a')),
    interaction: await read(tenantRecord(A, 'interactions', 'int_a_secret')),
    pilot: await read(tenantRecord(A, 'pilot', 'config')),
  };
}

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  const db = firestore();
  const batch = db.batch();
  for (const [t, name] of [
    [A, 'Lab A (secret name)'],
    [B, 'Lab B'],
  ] as const) {
    batch.set(db.doc(tenantDoc(t)), tenant(t, name));
    batch.set(db.doc(tenantRecord(t, 'sites', 'site_iso')), site);
  }
  batch.set(db.doc(tenantRecord(A, 'members', 'a_owner')), member('a_owner'));
  batch.set(db.doc(tenantRecord(B, 'members', 'b_all')), member('b_all'));
  // Same lab as A, but only allowed at a different site.
  batch.set(db.doc(tenantRecord(A, 'sites', 'site_north')), {
    ...site,
    siteId: 'site_north',
    displayName: 'North',
  });
  batch.set(db.doc(tenantRecord(A, 'members', 'a_north')), {
    ...member('a_north'),
    roleSet: ['REVIEWER', 'COORDINATOR', 'VERIFIER'],
    permittedSiteIds: ['site_north'],
  });
  const patient: Patient = {
    patientId: 'pat_a',
    externalRef: 'ext_ref_a_secret',
    alias: 'Alias A Secret',
    contactMasked: '+91 •• 77',
    ageEligibility: 'ADULT_CONFIRMED',
    language: 'en-IN',
    identityMethodRef: 'x',
  };
  const consent: Consent = {
    consentId: 'consent_a',
    patientId: 'pat_a',
    purpose: 'FOLLOW_UP_COORDINATION',
    channels: ['BROWSER_VOICE'],
    noticeVersion: 'v1',
    recordedBy: 'a_owner',
    proofRef: 'p',
    grantedAt: '2026-01-01T00:00:00Z',
    revokedAt: null,
    expiresAt: null,
    version: 1,
  };
  const source: Source = {
    sourceId: 'src_a',
    sourceAuthority: 'clinic',
    documentType: 'FORM',
    reference: 'ORD-A',
  };
  batch.set(db.doc(tenantRecord(A, 'patients', 'pat_a')), patient);
  batch.set(db.doc(tenantRecord(A, 'consents', 'consent_a')), consent);
  batch.set(db.doc(tenantRecord(A, 'sources', 'src_a')), source);
  await batch.commit();

  // Lab A: a contacted case with a handoff, an evidence record, a booking and a failed job.
  const cmd = new CaseCommands({
    store: new FirestoreStore(db),
    config: { outreachEnabled: true, maxContactAttempts: 2, maxCaseAudioSeconds: 180 },
  });
  const ctx: ActorContext = {
    tenantId: A,
    actorType: 'STAFF',
    actorId: 'a_owner',
    roles: ['OWNER', 'REVIEWER', 'COORDINATOR', 'VERIFIER'],
    correlationId: 'iso',
  };
  const due = new Date(Date.now() + 10 * 86_400_000).toISOString();
  let r = await cmd.createCase(ctx, {
    idempotencyKey: 'a1',
    input: {
      caseId: 'CL-ISO-A',
      siteId: 'site_iso',
      patientId: 'pat_a',
      sourceId: 'src_a',
      consentId: 'consent_a',
      actionType: 'CONSULTATION',
      actionText: 'secret action text',
      dueAt: due,
      ownerId: 'a_owner',
      language: 'en-IN',
    },
  });
  const step = async (
    f: (b: {
      caseId: string;
      expectedVersion: number;
      idempotencyKey: string;
    }) => Promise<{ version: number; operationId: string | null }>,
    k: string,
  ) => {
    const out = await f({ caseId: 'CL-ISO-A', expectedVersion: r.version, idempotencyKey: k });
    r = { ...r, version: out.version };
    return out;
  };
  await step(
    (b) =>
      cmd.approve(ctx, {
        ...b,
        input: {
          sourceAuthorityRef: 'ORD-A',
          checkedFields: ['patient', 'action', 'dueAt', 'contact', 'owner', 'language', 'adult'],
        },
      }),
    'a2',
  );
  await step((b) => cmd.dispatchContact(ctx, { ...b, input: { channel: 'BROWSER_VOICE' } }), 'a3');
  const op = await step(
    (b) =>
      cmd.recordPatientRequest(ctx, {
        ...b,
        input: { interactionId: 'i', identityAssurance: 'SIMULATED', request: 'CALLBACK' },
      }),
    'a4',
  );
  await step(
    (b) =>
      cmd.recordEvidence(ctx, {
        ...b,
        input: {
          evidenceId: 'ev_iso_a',
          kind: 'STAFF_RECORD',
          issuer: 'x',
          eventType: 'APPOINTMENT_ATTENDED',
          patientRef: null,
          bookingRef: null,
          occurredAt: new Date().toISOString(),
          sourceRef: 'x',
          simulation: true,
        },
      }),
    'a5',
  );
  const c = (await db.doc(tenantRecord(A, 'cases', 'CL-ISO-A')).get()).data()!;
  ids.caseId = 'CL-ISO-A';
  ids.handoffId = c.activeHandoffId;
  ids.evidenceId = 'ev_iso_a';
  ids.operationId = op.operationId!;
  ids.bookingId = 'bk_iso_a';
  ids.jobId = 'job_iso_a';
  await db.doc(tenantRecord(A, 'bookings', 'bk_iso_a')).set({
    bookingId: 'bk_iso_a',
    caseId: 'CL-ISO-A',
    operationId: 'x',
    adapter: 'manual',
    slotId: 'x',
    status: 'PENDING_STAFF',
    externalRef: 'ext_bk_a',
    startsAt: null,
    location: null,
    reason: null,
    simulation: true,
    confirmedBy: null,
    lastReconciledAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  await db.doc(tenantRecord(A, 'interactions', 'int_a_secret')).set({
    interactionId: 'int_a_secret',
    caseId: 'CL-ISO-A',
    createdAt: new Date().toISOString(),
    reviewStatus: 'PENDING',
    status: 'ENDED',
  });
  await db.doc(tenantRecord(A, 'failed_jobs', 'job_iso_a')).set({
    jobId: 'job_iso_a',
    tenantId: A,
    caseId: 'CL-ISO-A',
    kind: 'BOOKING_REQUEST',
    operationId: 'x',
    reason: 'x',
    attempts: 3,
    failedAt: '2026-01-01T00:00:00Z',
  });

  const auth = getAuth(adminApp());
  const signIn = async (uid: string, tenantId: string) => {
    await auth.createUser({ uid, email: `${uid}@iso.careloop.test`, password: PASSWORD });
    await auth.setCustomUserClaims(uid, { tenantId });
    const res = await fetch(
      `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: `${uid}@iso.careloop.test`,
          password: PASSWORD,
          returnSecureToken: true,
        }),
      },
    );
    return ((await res.json()) as { idToken: string }).idToken;
  };
  tokenB = await signIn('b_all', B);
  tokenNorth = await signIn('a_north', A);
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await firestore().terminate();
});

/** A body that passes each route's schema, aimed at lab A. */
function bodyFor(route: string): unknown {
  const now = new Date().toISOString();
  const v = { expectedVersion: 1 };
  const table: Record<string, unknown> = {
    '/v1/cases': {
      siteId: 'site_iso',
      patientId: 'pat_a',
      consentId: 'consent_a',
      source: { sourceAuthority: 'clinic', reference: 'ORD-B' },
      actionType: 'CONSULTATION',
      actionText: 'x',
      dueAt: now,
      ownerId: 'b_all',
      language: 'en-IN',
    },
    '/v1/cases/[id]/approve': {
      ...v,
      sourceAuthorityRef: 'x',
      checkedFields: ['patient', 'action', 'dueAt', 'contact', 'owner', 'language', 'adult'],
    },
    '/v1/cases/[id]/draft': { ...v, edit: { actionText: 'changed by B' } },
    '/v1/cases/[id]/contact-requests': { ...v, channel: 'BROWSER_VOICE' },
    '/v1/cases/[id]/patient-requests': { ...v, request: 'BOOK' },
    '/v1/cases/[id]/booking-requests': { ...v, slotId: 'slot_x', patientConfirmedSlot: true },
    '/v1/cases/[id]/evidence': {
      ...v,
      kind: 'STAFF_RECORD',
      issuer: 'x',
      eventType: 'APPOINTMENT_ATTENDED',
      occurredAt: now,
      sourceRef: 'x',
    },
    '/v1/cases/[id]/cancel': { ...v, reason: 'x' },
    '/v1/cases/[id]/reopen': { ...v, reason: 'x' },
    '/v1/cases/[id]/patient-links': {},
    '/v1/cases/[id]/simulate-provider-event': { scenario: 'MATCHING' },
    '/v1/evidence/[id]/attest': { ...v, decision: 'VERIFY', reason: 'x', sourceRef: 'x' },
    '/v1/handoffs/[id]/[action]': {
      ...v,
      resolution: 'x',
      resumeAutomation: true,
      ownerId: 'b_all',
    },
    '/v1/bookings/[id]/cancel': { ...v, reason: 'x' },
    '/v1/bookings/[id]/confirm-manual': { ...v, externalRef: 'x', startsAt: now },
    '/v1/consents/[id]/revoke': { reason: 'x' },
    '/v1/jobs/[id]/replay': {},
    '/v1/voice/sessions': { caseId: ids.caseId },
    '/v1/settings/outreach': { paused: true, reason: 'B pausing' },
    '/v1/patients/[id]/erasure': { reason: 'B erasing' },
    '/v1/time-logs': { caseId: ids.caseId, minutes: 5, activity: 'CALL' },
    '/v1/reviews/[id]': { outcome: 'OK', issues: [] },
    '/v1/pilot/config': {
      phase: 'BASELINE',
      concurrentComparison: true,
      interventionShare: 0.5,
      supervisedReviewFirstN: 5,
      costRates: {
        voicePerMinuteInr: 1,
        messageInr: 0,
        modelPerCaseInr: 0,
        directSupportPerMonthInr: 0,
      },
      pricing: { sitePerMonthInr: 2999, perEnrolledCaseInr: 25 },
    },
    '/v1/sites': {
      siteId: 'site_new',
      displayName: 'New site',
      timeZone: 'Asia/Kolkata',
      contactWindow: { start: '09:00', end: '18:00' },
    },
    '/v1/members/[id]/sites': { permittedSiteIds: ['site_iso'] },
    '/v1/billing/statements': { month: '2026-01' },
    '/v1/intake/csv': {
      csv: 'patient_ref,action_type,action_text,due_date,source_authority,reference\next_ref_a_secret,CONSULTATION,x,2030-01-01,clinic,ORD-A\n',
    },
    '/v1/intake/pdf': { pdfBase64: Buffer.from('not a pdf, just text here').toString('base64') },
    '/v1/intake': { text: 'Order ORD-A, consultation due 2026-12-01, approved by clinic.' },
  };
  return table[route] ?? {};
}

function paramsFor(route: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (route.includes('/cases/[id]')) p.id = ids.caseId!;
  if (route.includes('/evidence/[id]')) p.id = ids.evidenceId!;
  if (route.includes('/handoffs/[id]')) p.id = ids.handoffId!;
  if (route.includes('/bookings/[id]')) p.id = ids.bookingId!;
  if (route.includes('/consents/[id]')) p.id = 'consent_a';
  if (route.includes('/patients/[id]')) p.id = 'pat_a';
  if (route.includes('/reviews/[id]')) p.id = 'int_a_secret';
  if (route.includes('/operations/[id]')) p.id = ids.operationId!;
  if (route.includes('/jobs/[id]')) p.id = ids.jobId!;
  if (route.includes('/members/[id]')) p.id = 'a_owner';
  if (route.includes('[month]')) p.month = '2026-01';
  if (route.includes('[action]')) p.action = 'acknowledge';
  return p;
}

/** Routes with no lab-A target: they may succeed, but only with lab B's own data. */
const OWN_TENANT_ROUTES = new Set([
  '/v1/me',
  '/v1/me/outreach',
  '/v1/lookups',
  '/v1/overview',
  '/v1/cases',
  '/v1/reports',
  '/v1/notifications',
  '/v1/handoffs',
  '/v1/bookings',
  '/v1/jobs/failed',
  '/v1/settings/outreach',
  '/v1/intake',
  '/v1/intake/csv',
  '/v1/intake/pdf',
  '/v1/ops/metrics',
  '/v1/reviews',
  '/v1/pilot/config',
  '/v1/pilot/report',
  '/v1/sites',
  '/v1/members',
  '/v1/intake/lims',
  '/v1/billing/statements',
]);
/** Same path, different meaning per method: the GET lists the caller's own lab; the POST targets a case. */
const OWN_TENANT_GETS = new Set(['/v1/time-logs']);
const NOT_STAFF = (r: string) =>
  r.startsWith('/v1/p/') || r.startsWith('/webhooks') || r.startsWith('/api/');
const LAB_A_MARKERS = [
  'CL-ISO-A',
  'Alias A Secret',
  'ext_ref_a_secret',
  'secret action text',
  'Lab A (secret name)',
  'consent_a',
  'ev_iso_a',
  'ext_bk_a',
  'job_iso_a',
];

describe('tenant isolation sweep', () => {
  const routes = Object.entries(modules)
    .map(([file, mod]) => ({ route: file.replace('../app', '').replace('/route.ts', ''), mod }))
    .filter((r) => !NOT_STAFF(r.route));

  it('covers every staff route in the app', () => {
    expect(routes.length).toBeGreaterThanOrEqual(37);
  });

  it('refuses anonymous calls on every staff route', async () => {
    for (const { route, mod } of routes) {
      for (const method of ['GET', 'POST', 'PATCH'] as const) {
        const handler = mod[method] as ((r: Request, c: unknown) => Promise<Response>) | undefined;
        if (!handler) continue;
        const res = await handler(
          new Request(`http://localhost${route}`, {
            method,
            body: method === 'GET' ? undefined : '{}',
          }),
          { params: Promise.resolve(paramsFor(route)) },
        );
        expect(res.status, `${method} ${route}`).toBe(401);
      }
    }
  });

  it('a fully privileged member of another lab can neither read nor change lab A', async () => {
    const before = await snapshotA();
    const findings: string[] = [];
    for (const { route, mod } of routes) {
      for (const method of ['GET', 'POST', 'PATCH'] as const) {
        const handler = mod[method] as ((r: Request, c: unknown) => Promise<Response>) | undefined;
        if (!handler) continue;
        const headers: Record<string, string> = {
          authorization: `Bearer ${tokenB}`,
          'idempotency-key': `iso-${method}-${route}`,
        };
        const query = route === '/v1/reports' ? '?from=2020-01-01&to=2030-12-31' : '';
        const req = new Request(`http://localhost${route}${query}`, {
          method,
          headers,
          body: method === 'GET' ? undefined : JSON.stringify(bodyFor(route)),
        });
        const res = await handler(req, { params: Promise.resolve(paramsFor(route)) });
        const text = await res.text();
        const leaked = LAB_A_MARKERS.filter((m) => text.includes(m));
        if (leaked.length) findings.push(`${method} ${route} leaked ${leaked.join(', ')}`);
        if (
          !(OWN_TENANT_ROUTES.has(route) || (method === 'GET' && OWN_TENANT_GETS.has(route))) &&
          res.status < 400
        )
          findings.push(`${method} ${route} returned ${res.status} for a lab-A target`);
        if (
          !(OWN_TENANT_ROUTES.has(route) || (method === 'GET' && OWN_TENANT_GETS.has(route))) &&
          ![403, 404].includes(res.status)
        )
          findings.push(`${method} ${route} returned ${res.status} (expected 403/404)`);
      }
    }
    expect(findings).toEqual([]);
    expect(await snapshotA()).toEqual(before);
  });

  it("a member of the same lab limited to another site cannot read or change that site's case", async () => {
    // Patients, consents and the lab name are lab-wide, so only case-specific values count as leaks.
    const CASE_MARKERS = [
      'CL-ISO-A',
      'secret action text',
      'ev_iso_a',
      'ext_bk_a',
      'job_iso_a',
      'int_a_secret',
    ];
    // Lists and lab-level actions may succeed; anything aimed at the case may not.
    const MAY_SUCCEED = (method: string, route: string) =>
      (method === 'GET' && (OWN_TENANT_ROUTES.has(route) || OWN_TENANT_GETS.has(route))) ||
      ['/v1/intake', '/v1/intake/csv', '/v1/intake/pdf'].includes(route);
    const before = await snapshotA();
    const findings: string[] = [];
    for (const { route, mod } of routes) {
      for (const method of ['GET', 'POST', 'PATCH'] as const) {
        const handler = mod[method] as ((r: Request, c: unknown) => Promise<Response>) | undefined;
        if (!handler) continue;
        const query = route === '/v1/reports' ? '?from=2020-01-01&to=2030-12-31' : '';
        const res = await handler(
          new Request(`http://localhost${route}${query}`, {
            method,
            headers: {
              authorization: `Bearer ${tokenNorth}`,
              'idempotency-key': `north-${method}-${route}`,
            },
            body: method === 'GET' ? undefined : JSON.stringify(bodyFor(route)),
          }),
          { params: Promise.resolve(paramsFor(route)) },
        );
        const text = await res.text();
        const leaked = CASE_MARKERS.filter((m) => text.includes(m));
        if (leaked.length) findings.push(`${method} ${route} leaked ${leaked.join(', ')}`);
        if (!MAY_SUCCEED(method, route) && ![403, 404].includes(res.status))
          findings.push(`${method} ${route} returned ${res.status} (expected 403/404)`);
      }
    }
    expect(findings).toEqual([]);
    expect(await snapshotA()).toEqual(before);
  });
});
