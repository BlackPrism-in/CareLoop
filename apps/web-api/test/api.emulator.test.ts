import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
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
});
