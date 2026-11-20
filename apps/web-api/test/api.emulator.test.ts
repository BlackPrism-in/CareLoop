import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from 'firebase-admin/auth';
import type { FixtureBundle } from '@careloop/contracts';
import { tenantDoc, tenantRecord } from '@careloop/domain';
import { adminApp, firestore } from '@/server/firebase';
import { GET as getMe } from '../app/v1/me/route';
import { GET as listCases, POST as createCase } from '../app/v1/cases/route';
import { GET as getCase } from '../app/v1/cases/[id]/route';
import { POST as approveCase } from '../app/v1/cases/[id]/approve/route';
import { PATCH as editDraft } from '../app/v1/cases/[id]/draft/route';
import { POST as contactRequest } from '../app/v1/cases/[id]/contact-requests/route';
import { POST as patientRequest } from '../app/v1/cases/[id]/patient-requests/route';
import { GET as listSlots } from '../app/v1/cases/[id]/slots/route';
import { POST as bookingRequest } from '../app/v1/cases/[id]/booking-requests/route';
import { GET as getOperation } from '../app/v1/operations/[id]/route';
import { POST as replayJob } from '../app/v1/jobs/[id]/replay/route';
import { POST as voiceSession } from '../app/v1/voice/sessions/route';
import { consumeVoiceTicket } from '@careloop/domain';
import { signSandboxPayload } from '@careloop/jobs';
import { POST as recordEvidence } from '../app/v1/cases/[id]/evidence/route';
import { POST as attest } from '../app/v1/evidence/[id]/attest/route';
import { POST as webhook } from '../app/webhooks/[provider]/[account]/route';
import { POST as revoke } from '../app/v1/consents/[id]/revoke/route';
import { POST as pauseOutreach } from '../app/v1/settings/outreach/route';
import { POST as createLink } from '../app/v1/cases/[id]/patient-links/route';
import { POST as patientSession } from '../app/v1/p/session/route';
import { GET as patientMe } from '../app/v1/p/me/route';
import { POST as patientAction } from '../app/v1/p/actions/route';
import { POST as handoffAction } from '../app/v1/handoffs/[id]/[action]/route';
import { GET as report } from '../app/v1/reports/route';

/**
 * Exercises the real route handlers against the Auth + Firestore emulators
 * with real ID tokens. Covers MVP-01, MVP-02, tenant isolation and the error
 * envelope.
 */
const PROJECT = 'demo-careloop-api';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST!;
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST!;
const PASSWORD = 'test-only-password';
const fixture = JSON.parse(
  readFileSync(new URL('../../../evals/fixtures/demo-tenant.json', import.meta.url), 'utf8'),
) as FixtureBundle;
const T = fixture.tenant.tenantId;
const OTHER = 't_other_lab';

const tokens: Record<string, string> = {};

// Let background kicks settle, then close gRPC streams so the emulators shut down cleanly.
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await firestore().terminate();
});
// Relative to the real clock: these routes use wall-clock time.
const DUE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const SLOT_AT = new Date(Date.now() + 3 * 86_400_000).toISOString();

async function signIn(email: string): Promise<string> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    },
  );
  const j = (await res.json()) as { idToken: string };
  return j.idToken;
}

async function user(uid: string, email: string, tenantId: string) {
  const auth = getAuth(adminApp());
  await auth.createUser({ uid, email, password: PASSWORD });
  await auth.setCustomUserClaims(uid, { tenantId });
  tokens[uid] = await signIn(email);
}

function req(
  path: string,
  opts: { as?: string; method?: string; body?: unknown; key?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.as) headers.authorization = `Bearer ${tokens[opts.as]}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.key) headers['idempotency-key'] = opts.key;
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}
const params = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });
const noParams = params({});

const newCaseBody = (reference: string) => ({
  siteId: 'site_demo_main',
  patientId: 'pat_demo_01',
  consentId: 'consent_demo_01',
  source: { sourceAuthority: 'demo_clinic', reference },
  actionType: 'CONSULTATION',
  actionText: 'Arrange the approved clinic consultation',
  dueAt: DUE,
  ownerId: 'staff_demo_01',
  language: 'hi-IN',
});
const CHECKS = ['patient', 'action', 'dueAt', 'contact', 'owner', 'language', 'adult'];

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  const db = firestore();
  const batch = db.batch();
  batch.set(db.doc(tenantDoc(T)), fixture.tenant);
  // Open all day so the test doesn't depend on the time it runs.
  for (const s of fixture.sites)
    batch.set(db.doc(tenantRecord(T, 'sites', s.siteId)), {
      ...s,
      contactWindow: { start: '00:00', end: '23:59' },
    });
  batch.set(db.doc(tenantRecord(T, 'slots', 'slot_api_1')), {
    slotId: 'slot_api_1',
    siteId: 'site_demo_main',
    actionType: 'CONSULTATION',
    location: 'Demo Clinic, Room 2',
    startsAt: SLOT_AT,
    endsAt: new Date(Date.parse(SLOT_AT) + 1_800_000).toISOString(),
    capacity: 1,
    reserved: 0,
  });
  for (const m of fixture.members) batch.set(db.doc(tenantRecord(T, 'members', m.uid)), m);
  for (const p of fixture.patients) batch.set(db.doc(tenantRecord(T, 'patients', p.patientId)), p);
  for (const c of fixture.consents) batch.set(db.doc(tenantRecord(T, 'consents', c.consentId)), c);
  // A second lab with its own reviewer, to test isolation.
  batch.set(db.doc(tenantDoc(OTHER)), {
    ...fixture.tenant,
    tenantId: OTHER,
    displayName: 'Other Lab',
  });
  batch.set(db.doc(tenantRecord(OTHER, 'members', 'other_reviewer')), {
    ...fixture.members[1]!,
    uid: 'other_reviewer',
    email: 'rev@other.careloop.test',
  });
  // A suspended member.
  batch.set(db.doc(tenantRecord(T, 'members', 'suspended_user')), {
    ...fixture.members[2]!,
    uid: 'suspended_user',
    email: 'gone@demo.careloop.test',
    status: 'SUSPENDED',
  });
  batch.set(db.doc('provider_accounts/sandbox__demo-calendar'), { tenantId: T, active: true });
  batch.set(db.doc(tenantRecord(T, 'patients', 'pat_api_05')), {
    ...fixture.patients[0]!,
    patientId: 'pat_api_05',
    externalRef: 'patient_ref_api_05',
  });
  batch.set(db.doc(tenantRecord(T, 'consents', 'consent_api_05')), {
    ...fixture.consents[0]!,
    consentId: 'consent_api_05',
    patientId: 'pat_api_05',
  });
  await batch.commit();

  for (const m of fixture.members) await user(m.uid, m.email, T);
  await user('other_reviewer', 'rev@other.careloop.test', OTHER);
  await user('suspended_user', 'gone@demo.careloop.test', T);
});

describe('staff API on emulators', () => {
  let caseId = '';
  let version = 0;

  it('401 with the error envelope when no token is sent', async () => {
    const res = await getMe(req('/v1/me'), noParams);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });
    expect(body.correlationId).toBeTruthy();
    expect(res.headers.get('x-correlation-id')).toBe(body.correlationId);
  });

  it('403 for a suspended membership even with a valid token', async () => {
    expect((await getMe(req('/v1/me', { as: 'suspended_user' }), noParams)).status).toBe(403);
  });

  it('GET /v1/me returns roles from membership, not the token', async () => {
    const res = await getMe(req('/v1/me', { as: 'staff_demo_reviewer' }), noParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      uid: 'staff_demo_reviewer',
      roles: ['REVIEWER'],
      tenant: { tenantId: T },
    });
  });

  it('MVP-01: a coordinator creates a DRAFT; tenantId in the body is rejected', async () => {
    const bad = await createCase(
      req('/v1/cases', {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'k-bad',
        body: { ...newCaseBody('ORD-T1'), tenantId: OTHER },
      }),
      noParams,
    );
    expect(bad.status).toBe(400);

    const res = await createCase(
      req('/v1/cases', {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'k-create',
        body: newCaseBody('ORD-T1'),
      }),
      noParams,
    );
    expect(res.status).toBe(201);
    const r = await res.json();
    expect(r).toMatchObject({
      workflowState: 'DRAFT',
      automationPausedReason: 'REVIEW_REQUIRED',
      warnings: [],
    });
    caseId = r.caseId;
    version = r.version;

    const replay = await createCase(
      req('/v1/cases', {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'k-create',
        body: newCaseBody('ORD-T1'),
      }),
      noParams,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ caseId, replayed: true });

    const dup = await createCase(
      req('/v1/cases', {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'k-dup',
        body: newCaseBody('ord-t1'),
      }),
      noParams,
    );
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ caseId, warnings: ['DUPLICATE_SOURCE_ACTION'] });
  });

  it('requires an Idempotency-Key on writes', async () => {
    const res = await createCase(
      req('/v1/cases', { as: 'staff_demo_01', method: 'POST', body: newCaseBody('ORD-T2') }),
      noParams,
    );
    expect(res.status).toBe(400);
  });

  it('the auditor cannot create cases', async () => {
    const res = await createCase(
      req('/v1/cases', {
        as: 'staff_demo_auditor',
        method: 'POST',
        key: 'k-aud',
        body: newCaseBody('ORD-T3'),
      }),
      noParams,
    );
    expect(res.status).toBe(403);
  });

  it('MVP-02: coordinator 403, incomplete checklist 422, reviewer approves → READY', async () => {
    const body = { expectedVersion: version, sourceAuthorityRef: 'ORD-T1', checkedFields: CHECKS };
    const asCoord = await approveCase(
      req(`/v1/cases/${caseId}/approve`, { as: 'staff_demo_01', method: 'POST', key: 'a1', body }),
      params({ id: caseId }),
    );
    expect(asCoord.status).toBe(403);

    const partial = await approveCase(
      req(`/v1/cases/${caseId}/approve`, {
        as: 'staff_demo_reviewer',
        method: 'POST',
        key: 'a2',
        body: { ...body, checkedFields: ['patient'] },
      }),
      params({ id: caseId }),
    );
    expect(partial.status).toBe(422);
    expect((await partial.json()).message).toBe('APPROVAL_CHECKLIST_INCOMPLETE');

    const ok = await approveCase(
      req(`/v1/cases/${caseId}/approve`, {
        as: 'staff_demo_reviewer',
        method: 'POST',
        key: 'a3',
        body,
      }),
      params({ id: caseId }),
    );
    expect(ok.status).toBe(200);
    const r = await ok.json();
    expect(r.workflowState).toBe('READY');
    version = r.version;
  });

  it('a stale expectedVersion returns 409', async () => {
    const res = await editDraft(
      req(`/v1/cases/${caseId}/draft`, {
        as: 'staff_demo_01',
        method: 'PATCH',
        key: 'e1',
        body: { expectedVersion: version - 1, edit: { actionText: 'x' } },
      }),
      params({ id: caseId }),
    );
    expect(res.status).toBe(409);
  });

  it('a material edit after approval sends the case back to DRAFT', async () => {
    const res = await editDraft(
      req(`/v1/cases/${caseId}/draft`, {
        as: 'staff_demo_01',
        method: 'PATCH',
        key: 'e2',
        body: { expectedVersion: version, edit: { dueAt: '2026-12-21T06:30:00.000Z' } },
      }),
      params({ id: caseId }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      workflowState: 'DRAFT',
      eventType: 'CASE_EDITED_APPROVAL_INVALIDATED',
    });
  });

  it('detail includes the event timeline; another lab gets 404 for the same id', async () => {
    const mine = await getCase(
      req(`/v1/cases/${caseId}`, { as: 'staff_demo_auditor' }),
      params({ id: caseId }),
    );
    expect(mine.status).toBe(200);
    const d = await mine.json();
    expect(d.events.map((e: { eventType: string }) => e.eventType)).toEqual([
      'CASE_CREATED',
      'CASE_APPROVED',
      'CASE_EDITED_APPROVAL_INVALIDATED',
    ]);

    const theirs = await getCase(
      req(`/v1/cases/${caseId}`, { as: 'other_reviewer' }),
      params({ id: caseId }),
    );
    expect(theirs.status).toBe(404);
    const approveTheirs = await approveCase(
      req(`/v1/cases/${caseId}/approve`, {
        as: 'other_reviewer',
        method: 'POST',
        key: 'x1',
        body: { expectedVersion: 1, sourceAuthorityRef: 'x', checkedFields: CHECKS },
      }),
      params({ id: caseId }),
    );
    expect(approveTheirs.status).toBe(404);
  });

  it('lists with cursor pagination and the owner filter, scoped to the lab', async () => {
    for (const ref of ['ORD-P1', 'ORD-P2']) {
      await createCase(
        req('/v1/cases', {
          as: 'staff_demo_01',
          method: 'POST',
          key: `k-${ref}`,
          body: newCaseBody(ref),
        }),
        noParams,
      );
    }
    const page1 = await (
      await listCases(req('/v1/cases?limit=2', { as: 'staff_demo_01' }), noParams)
    ).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await (
      await listCases(
        req(`/v1/cases?limit=2&cursor=${page1.nextCursor}`, { as: 'staff_demo_01' }),
        noParams,
      )
    ).json();
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items].map((c: { caseId: string }) => c.caseId);
    expect(new Set(ids).size).toBe(3);
    expect(page1.items[0]).not.toHaveProperty('contactMasked');

    const mine = await (
      await listCases(req('/v1/cases?owner=me', { as: 'staff_demo_reviewer' }), noParams)
    ).json();
    expect(mine.items).toHaveLength(0);
    const other = await (
      await listCases(req('/v1/cases', { as: 'other_reviewer' }), noParams)
    ).json();
    expect(other.items).toHaveLength(0);
  });

  it('Phase 3: simulated contact → patient request → adapter slots → booking request (202, not yet booked)', async () => {
    const body = newCaseBody('ORD-BOOK');
    const created = await (
      await createCase(
        req('/v1/cases', { as: 'staff_demo_01', method: 'POST', key: 'k-book', body }),
        noParams,
      )
    ).json();
    const id = created.caseId as string;
    const p = params({ id });
    let v = (
      await (
        await approveCase(
          req(`/v1/cases/${id}/approve`, {
            as: 'staff_demo_reviewer',
            method: 'POST',
            key: 'b-a',
            body: {
              expectedVersion: created.version,
              sourceAuthorityRef: 'ORD-BOOK',
              checkedFields: CHECKS,
            },
          }),
          p,
        )
      ).json()
    ).version;

    // Outreach is disabled in this environment; a synthetic lab's browser session is still allowed.
    const contact = await contactRequest(
      req(`/v1/cases/${id}/contact-requests`, {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'b-c',
        body: { expectedVersion: v, channel: 'BROWSER_VOICE' },
      }),
      p,
    );
    expect(contact.status).toBe(202);
    v = (await contact.json()).version;
    // A reviewer can't start contact.
    expect(
      (
        await contactRequest(
          req(`/v1/cases/${id}/contact-requests`, {
            as: 'staff_demo_reviewer',
            method: 'POST',
            key: 'b-c2',
            body: { expectedVersion: v, channel: 'BROWSER_VOICE' },
          }),
          p,
        )
      ).status,
    ).toBe(403);

    const asked = await (
      await patientRequest(
        req(`/v1/cases/${id}/patient-requests`, {
          as: 'staff_demo_01',
          method: 'POST',
          key: 'b-p',
          body: { expectedVersion: v, request: 'BOOK' },
        }),
        p,
      )
    ).json();
    expect(asked.workflowState).toBe('AWAITING_BOOKING');
    v = asked.version;

    const slots = await (
      await listSlots(req(`/v1/cases/${id}/slots`, { as: 'staff_demo_01' }), p)
    ).json();
    expect(slots.adapter).toBe('sandbox');
    expect(slots.slots.map((s: { slotId: string }) => s.slotId)).toContain('slot_api_1');

    // MVP-04: a slot the adapter didn't offer is refused; so is a missing patient confirmation.
    const invented = await bookingRequest(
      req(`/v1/cases/${id}/booking-requests`, {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'b-x',
        body: { expectedVersion: v, slotId: 'slot_made_up', patientConfirmedSlot: true },
      }),
      p,
    );
    expect(invented.status).toBe(422);
    expect((await invented.json()).message).toBe('SLOT_NOT_OFFERED_BY_ADAPTER');
    const unconfirmed = await bookingRequest(
      req(`/v1/cases/${id}/booking-requests`, {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'b-y',
        body: { expectedVersion: v, slotId: 'slot_api_1', patientConfirmedSlot: false },
      }),
      p,
    );
    expect(unconfirmed.status).toBe(400);

    const booked = await bookingRequest(
      req(`/v1/cases/${id}/booking-requests`, {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'b-b',
        body: { expectedVersion: v, slotId: 'slot_api_1', patientConfirmedSlot: true },
      }),
      p,
    );
    expect(booked.status).toBe(202);
    const r = await booked.json();
    expect(r).toMatchObject({ workflowState: 'AWAITING_BOOKING', bookingState: 'REQUESTED' });
    expect(r.operationId).toMatch(/^[a-f0-9]{64}$/);

    const op = await getOperation(
      req(`/v1/operations/${r.operationId}`, { as: 'staff_demo_auditor' }),
      params({ id: r.operationId }),
    );
    expect(op.status).toBe(200);
    expect(await op.json()).toMatchObject({ command: 'requestBooking', caseId: id });
    expect(
      (
        await getOperation(
          req(`/v1/operations/${r.operationId}`, { as: 'other_reviewer' }),
          params({ id: r.operationId }),
        )
      ).status,
    ).toBe(404);
  });

  it('only an owner can replay failed jobs', async () => {
    const res = await replayJob(
      req('/v1/jobs/anything/replay', { as: 'staff_demo_01', method: 'POST', body: {} }),
      params({ id: 'anything' }),
    );
    expect(res.status).toBe(403);
    const missing = await replayJob(
      req('/v1/jobs/anything/replay', { as: 'staff_demo_owner', method: 'POST', body: {} }),
      params({ id: 'anything' }),
    );
    expect(missing.status).toBe(404);
  });

  it('Phase 4: voice tickets are coordinator-only, case-bound and never contain a model key', async () => {
    const created = await (
      await createCase(
        req('/v1/cases', {
          as: 'staff_demo_01',
          method: 'POST',
          key: 'k-voice',
          body: newCaseBody('ORD-VOICE'),
        }),
        noParams,
      )
    ).json();
    const id = created.caseId as string;
    // Not in contact yet → refused.
    const early = await voiceSession(
      req('/v1/voice/sessions', { as: 'staff_demo_01', method: 'POST', body: { caseId: id } }),
      noParams,
    );
    expect(early.status).toBe(422);
    const v = (
      await (
        await approveCase(
          req(`/v1/cases/${id}/approve`, {
            as: 'staff_demo_reviewer',
            method: 'POST',
            key: 'v-a',
            body: {
              expectedVersion: created.version,
              sourceAuthorityRef: 'ORD-VOICE',
              checkedFields: CHECKS,
            },
          }),
          params({ id }),
        )
      ).json()
    ).version;
    await contactRequest(
      req(`/v1/cases/${id}/contact-requests`, {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'v-c',
        body: { expectedVersion: v, channel: 'BROWSER_VOICE' },
      }),
      params({ id }),
    );

    expect(
      (
        await voiceSession(
          req('/v1/voice/sessions', {
            as: 'staff_demo_reviewer',
            method: 'POST',
            body: { caseId: id },
          }),
          noParams,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await voiceSession(
          req('/v1/voice/sessions', { as: 'other_reviewer', method: 'POST', body: { caseId: id } }),
          noParams,
        )
      ).status,
    ).toBe(403);

    const res = await voiceSession(
      req('/v1/voice/sessions', { as: 'staff_demo_01', method: 'POST', body: { caseId: id } }),
      noParams,
    );
    expect(res.status).toBe(201);
    const s = await res.json();
    expect(Object.keys(s).sort()).toEqual([
      'expiresAt',
      'interactionId',
      'simulation',
      'ticket',
      'wsUrl',
    ]);
    expect(JSON.stringify(s)).not.toMatch(/key|patient|alias/i);
    const ticket = await consumeVoiceTicket(firestore(), s.ticket);
    expect(ticket).toMatchObject({
      tenantId: T,
      caseId: id,
      interactionId: s.interactionId,
      createdBy: 'staff_demo_01',
    });
    expect(await consumeVoiceTicket(firestore(), s.ticket)).toBeNull();
  });

  /** Creates, approves and (optionally) starts contact on a fresh case. Returns id + current version. */
  async function readyCase(
    ref: string,
    consentId = 'consent_demo_01',
    patientId = 'pat_demo_01',
    contact = false,
  ) {
    const body = { ...newCaseBody(ref), consentId, patientId };
    const c = await (
      await createCase(
        req('/v1/cases', { as: 'staff_demo_01', method: 'POST', key: `k-${ref}`, body }),
        noParams,
      )
    ).json();
    let v = (
      await (
        await approveCase(
          req(`/v1/cases/${c.caseId}/approve`, {
            as: 'staff_demo_reviewer',
            method: 'POST',
            key: `a-${ref}`,
            body: { expectedVersion: c.version, sourceAuthorityRef: ref, checkedFields: CHECKS },
          }),
          params({ id: c.caseId }),
        )
      ).json()
    ).version;
    if (contact)
      v = (
        await (
          await contactRequest(
            req(`/v1/cases/${c.caseId}/contact-requests`, {
              as: 'staff_demo_01',
              method: 'POST',
              key: `c-${ref}`,
              body: { expectedVersion: v, channel: 'BROWSER_VOICE' },
            }),
            params({ id: c.caseId }),
          )
        ).json()
      ).version;
    return { id: c.caseId as string, v: v as number };
  }

  it('Phase 5: a staff record waits for a verifier; only a verifier attests; a self-report is never verified', async () => {
    const { id, v } = await readyCase('ORD-EV');
    const p = params({ id });
    // Must be after the approval a moment ago: earlier attendance can't satisfy this obligation.
    const ev = {
      kind: 'STAFF_RECORD',
      issuer: 'Other clinic letter',
      eventType: 'APPOINTMENT_ATTENDED',
      occurredAt: new Date().toISOString(),
      sourceRef: 'letter 22/11',
    };
    const rec = await recordEvidence(
      req(`/v1/cases/${id}/evidence`, {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'ev-1',
        body: { expectedVersion: v, ...ev },
      }),
      p,
    );
    expect(rec.status).toBe(201);
    const r1 = await rec.json();
    expect(r1).toMatchObject({ workflowState: 'READY', evidenceState: 'UNDER_REVIEW' });
    const evidenceId = (
      await firestore().collection(`tenants/${T}/evidence`).where('caseId', '==', id).get()
    ).docs[0]!.id;
    const asCoord = await attest(
      req(`/v1/evidence/${evidenceId}/attest`, {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'at-1',
        body: { expectedVersion: r1.version, decision: 'VERIFY', reason: 'x', sourceRef: 'letter' },
      }),
      params({ id: evidenceId }),
    );
    expect(asCoord.status).toBe(403);
    const ok = await attest(
      req(`/v1/evidence/${evidenceId}/attest`, {
        as: 'staff_demo_verifier',
        method: 'POST',
        key: 'at-2',
        body: {
          expectedVersion: r1.version,
          decision: 'VERIFY',
          reason: 'Confirmed by phone with the other clinic',
          sourceRef: 'letter 22/11',
        },
      }),
      params({ id: evidenceId }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      workflowState: 'COMPLETED_VERIFIED',
      bookingState: 'NONE',
    });

    const two = await readyCase('ORD-EV2');
    const self = await (
      await recordEvidence(
        req(`/v1/cases/${two.id}/evidence`, {
          as: 'staff_demo_01',
          method: 'POST',
          key: 'ev-s',
          body: { expectedVersion: two.v, ...ev, kind: 'SELF_REPORT', issuer: 'patient' },
        }),
        params({ id: two.id }),
      )
    ).json();
    expect(self.evidenceState).toBe('SELF_REPORTED');
    const selfId = (
      await firestore().collection(`tenants/${T}/evidence`).where('caseId', '==', two.id).get()
    ).docs[0]!.id;
    const no = await attest(
      req(`/v1/evidence/${selfId}/attest`, {
        as: 'staff_demo_verifier',
        method: 'POST',
        key: 'at-s',
        body: {
          expectedVersion: self.version,
          decision: 'VERIFY',
          reason: 'patient said so',
          sourceRef: 'call',
        },
      }),
      params({ id: selfId }),
    );
    expect(no.status).toBe(422);
    expect((await no.json()).message).toBe('SELF_REPORT_NOT_INDEPENDENT');
  });

  it('Phase 5: webhooks need a valid signature; the tenant comes from the account, not the payload', async () => {
    const event = {
      eventId: 'wh-1',
      eventType: 'APPOINTMENT_ATTENDED',
      sourceSystem: 'sandbox_calendar',
      patientExternalRef: 'patient_ref_demo_03',
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      simulation: true,
    };
    const raw = JSON.stringify(event);
    const send = (sig: string, account = 'demo-calendar') =>
      webhook(
        new Request(`http://localhost/webhooks/sandbox/${account}`, {
          method: 'POST',
          body: raw,
          headers: { 'x-careloop-signature': sig },
        }),
        { params: Promise.resolve({ provider: 'sandbox', account }) },
      );
    const now = Math.floor(Date.now() / 1000);
    expect((await send(signSandboxPayload('wrong-secret-xxxxxxxxxxxx', now, raw))).status).toBe(
      401,
    );
    expect(
      (await send(signSandboxPayload('api-test-webhook-secret-01', now, raw), 'unknown')).status,
    ).toBe(404);
    const ok = await send(signSandboxPayload('api-test-webhook-secret-01', now, raw));
    expect(ok.status).toBe(202);
    expect((await send(signSandboxPayload('api-test-webhook-secret-01', now, raw))).status).toBe(
      200,
    ); // duplicate
  });

  it('MVP-07: withdrawing consent suppresses contact on every open case immediately', async () => {
    const { id, v } = await readyCase('ORD-CONSENT', 'consent_api_05', 'pat_api_05');
    expect(v).toBeGreaterThan(0);
    const r = await revoke(
      req('/v1/consents/consent_api_05/revoke', {
        as: 'staff_demo_01',
        method: 'POST',
        body: { reason: 'Patient asked by phone' },
      }),
      params({ id: 'consent_api_05' }),
    );
    expect(r.status).toBe(200);
    expect((await r.json()).casesSuppressed).toContain(id);
    const detail = await (
      await getCase(req(`/v1/cases/${id}`, { as: 'staff_demo_01' }), params({ id }))
    ).json();
    expect(detail.case.outreachDisposition).toBe('OPTED_OUT');
    const blocked = await contactRequest(
      req(`/v1/cases/${id}/contact-requests`, {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'cc',
        body: { expectedVersion: detail.case.version, channel: 'BROWSER_VOICE' },
      }),
      params({ id }),
    );
    expect(blocked.status).toBe(422);
  });

  it('only an owner can pause outreach; a pause blocks contact at execution time', async () => {
    const { id, v } = await readyCase('ORD-PAUSE');
    expect(
      (
        await pauseOutreach(
          req('/v1/settings/outreach', {
            as: 'staff_demo_01',
            method: 'POST',
            body: { paused: true, reason: 'x' },
          }),
          noParams,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await pauseOutreach(
          req('/v1/settings/outreach', {
            as: 'staff_demo_owner',
            method: 'POST',
            body: { paused: true, reason: 'Phone lines down' },
          }),
          noParams,
        )
      ).status,
    ).toBe(200);
    const blocked = await contactRequest(
      req(`/v1/cases/${id}/contact-requests`, {
        as: 'staff_demo_01',
        method: 'POST',
        key: 'pp',
        body: { expectedVersion: v, channel: 'BROWSER_VOICE' },
      }),
      params({ id }),
    );
    expect((await blocked.json()).message).toBe('SITE_PAUSED');
    await pauseOutreach(
      req('/v1/settings/outreach', {
        as: 'staff_demo_owner',
        method: 'POST',
        body: { paused: false, reason: 'Lines restored' },
      }),
      noParams,
    );
  });

  it('patient link: code gate, no private data, actions as the patient, lock after five wrong codes', async () => {
    const { id } = await readyCase('ORD-LINK', 'consent_demo_02', 'pat_demo_02', true);
    expect(
      (
        await createLink(
          req(`/v1/cases/${id}/patient-links`, {
            as: 'staff_demo_reviewer',
            method: 'POST',
            body: {},
          }),
          params({ id }),
        )
      ).status,
    ).toBe(403);
    const link = await (
      await createLink(
        req(`/v1/cases/${id}/patient-links`, { as: 'staff_demo_01', method: 'POST', body: {} }),
        params({ id }),
      )
    ).json();
    const token = String(link.url).split('/p/')[1]!;
    const sess = (code: string) =>
      patientSession(
        new Request('http://localhost/v1/p/session', {
          method: 'POST',
          body: JSON.stringify({ token, code }),
        }),
      );
    expect((await patientMe(new Request('http://localhost/v1/p/me'))).status).toBe(401); // link alone shows nothing
    const wrongCode = link.code === '000000' ? '111111' : '000000';
    expect((await sess(wrongCode)).status).toBe(401);
    const good = await sess(link.code);
    expect(good.status).toBe(200);
    const cookie = good.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const asPatient = (r: string, init: RequestInit = {}) =>
      new Request(`http://localhost${r}`, { ...init, headers: { cookie: cookie.split(';')[0]! } });
    const me = await (await patientMe(asPatient('/v1/p/me'))).json();
    expect(me).toMatchObject({
      labName: 'Siliguri Demo Lab',
      followUp: 'CONSULTATION',
      automatedContact: true,
      simulation: true,
    });
    expect(JSON.stringify(me)).not.toMatch(
      /Patient B|patient_ref|\+91|actionText|Arrange the approved|staff_demo/,
    );

    expect(
      (
        await patientAction(
          asPatient('/v1/p/actions', {
            method: 'POST',
            body: JSON.stringify({ action: 'REQUEST_CALLBACK' }),
          }),
        )
      ).status,
    ).toBe(200);
    let detail = await (
      await getCase(req(`/v1/cases/${id}`, { as: 'staff_demo_01' }), params({ id }))
    ).json();
    expect(detail.handoff).toMatchObject({
      reasonCode: 'CALLBACK_REQUESTED',
      status: 'PENDING',
      createdBy: 'patient:pat_demo_02',
    });
    expect(
      (
        await patientAction(
          asPatient('/v1/p/actions', {
            method: 'POST',
            body: JSON.stringify({ action: 'STOP_CONTACT' }),
          }),
        )
      ).status,
    ).toBe(200);
    detail = await (
      await getCase(req(`/v1/cases/${id}`, { as: 'staff_demo_01' }), params({ id }))
    ).json();
    expect(detail.consent.active).toBe(false);
    expect(detail.case.outreachDisposition).toBe('OPTED_OUT');
    // A patient session is not a staff credential.
    expect((await getCase(asPatient(`/v1/cases/${id}`), params({ id }))).status).toBe(401);

    const link2 = await (
      await createLink(
        req(`/v1/cases/${id}/patient-links`, { as: 'staff_demo_01', method: 'POST', body: {} }),
        params({ id }),
      )
    ).json();
    const token2 = String(link2.url).split('/p/')[1]!;
    const bad = link2.code === '999999' ? '888888' : '999999';
    for (let i = 0; i < 5; i++)
      await patientSession(
        new Request('http://localhost/v1/p/session', {
          method: 'POST',
          body: JSON.stringify({ token: token2, code: bad }),
        }),
      );
    const locked = await patientSession(
      new Request('http://localhost/v1/p/session', {
        method: 'POST',
        body: JSON.stringify({ token: token2, code: link2.code }),
      }),
    );
    expect(locked.status).toBe(403);
  });

  it('MVP-11: only the handoff owner acknowledges unless a reviewer/owner takes over; reassignment works', async () => {
    const { id } = await readyCase('ORD-HO', 'consent_demo_01', 'pat_demo_01', true);
    const asked = await (
      await patientRequest(
        req(`/v1/cases/${id}/patient-requests`, {
          as: 'staff_demo_01',
          method: 'POST',
          key: 'ho-p',
          body: {
            expectedVersion: (
              await (
                await getCase(req(`/v1/cases/${id}`, { as: 'staff_demo_01' }), params({ id }))
              ).json()
            ).case.version,
            request: 'CALLBACK',
          },
        }),
        params({ id }),
      )
    ).json();
    const detail = await (
      await getCase(req(`/v1/cases/${id}`, { as: 'staff_demo_01' }), params({ id }))
    ).json();
    const hid = detail.handoff.handoffId as string;
    const hp = (action: string) => params({ id: hid, action });
    const notOwner = await handoffAction(
      req(`/v1/handoffs/${hid}/acknowledge`, {
        as: 'staff_demo_verifier',
        method: 'POST',
        key: 'h1',
        body: { expectedVersion: asked.version },
      }),
      hp('acknowledge'),
    );
    expect(notOwner.status).toBe(403);
    const re = await (
      await handoffAction(
        req(`/v1/handoffs/${hid}/reassign`, {
          as: 'staff_demo_reviewer',
          method: 'POST',
          key: 'h2',
          body: { expectedVersion: asked.version, ownerId: 'staff_demo_verifier' },
        }),
        hp('reassign'),
      )
    ).json();
    const ack = await handoffAction(
      req(`/v1/handoffs/${hid}/acknowledge`, {
        as: 'staff_demo_verifier',
        method: 'POST',
        key: 'h3',
        body: { expectedVersion: re.version },
      }),
      hp('acknowledge'),
    );
    expect(ack.status).toBe(200);
    expect((await ack.json()).workflowState).toBe('AWAITING_BOOKING'); // acknowledgment is not completion
  });

  it('MVP-12: reports keep bookings, self-reports and verified completions separate', async () => {
    const day = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 10);
    const r = await (
      await report(
        req(`/v1/reports?from=${day(-86_400_000)}&to=${day(40 * 86_400_000)}&cohort=due`, {
          as: 'staff_demo_auditor',
        }),
        noParams,
      )
    ).json();
    expect(r.separateCounts.verifiedCompleted).toBeGreaterThanOrEqual(1); // ORD-EV was attested
    expect(r.separateCounts.selfReportedOnly).toBeGreaterThanOrEqual(1); // ORD-EV2 self-report
    // Every test case is still inside its due date, so nothing is in the denominator yet.
    expect(r.primary.denominator).toBe(0);
    expect(r.primary.rate).toBeNull();
    expect(r.primary.exclusions.followUpWindowStillOpen).toBeGreaterThan(0);
    const other = await (
      await report(
        req(`/v1/reports?from=${day(-86_400_000)}&to=${day(40 * 86_400_000)}`, {
          as: 'other_reviewer',
        }),
        noParams,
      )
    ).json();
    expect(other.cohort.cases).toBe(0);
  });
});
