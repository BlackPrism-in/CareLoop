import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Case, Consent, Member, Patient, Site, Source, Tenant } from '@careloop/contracts';
import { setPatientWhatsApp, tenantDoc, tenantRecord, type ActorContext } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { caseCommands } from '@/server/services';
import { POST as start } from '../app/v1/m/auth/start/route';
import { POST as verify } from '../app/v1/m/auth/verify/route';
import { GET as me } from '../app/v1/m/me/route';
import { GET as getCase } from '../app/v1/m/cases/[ref]/route';
import { POST as book } from '../app/v1/m/cases/[ref]/book/route';
import { POST as act } from '../app/v1/m/cases/[ref]/actions/route';

/** Patient app: WhatsApp-code sign-in, own follow-ups only, booking through the calendar. */
const PROJECT = 'demo-careloop-api';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST!;
const T = 't_mobile';
const PHONE = '+919800000101';
const OTHER = '+919800000202';

const post = (body: unknown, token?: string) =>
  new Request('http://localhost/x', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const get = (token?: string) =>
  new Request('http://localhost/x', { headers: token ? { authorization: `Bearer ${token}` } : {} });
const params = <P>(p: P) => ({ params: Promise.resolve(p) });
const json = async (r: Response) => ({
  status: r.status,
  body: (await r.json()) as Record<string, any>,
});

async function signIn(phone: string): Promise<string> {
  const s = await json(await start(post({ phone })));
  expect(s.status).toBe(200);
  const v = await json(await verify(post({ phone, code: s.body.simulatedCode })));
  expect(v.status).toBe(200);
  return v.body.token as string;
}

const staff = (uid: string, role: ActorContext['roles'][number]): ActorContext => ({
  tenantId: T,
  actorType: 'STAFF',
  actorId: uid,
  roles: [role],
  correlationId: `t-${uid}`,
});

async function approvedCase(caseId: string, patientId: string, consentId: string): Promise<Case> {
  const cmd = caseCommands();
  const coord = staff('u_coord', 'COORDINATOR');
  let v = (
    await cmd.createCase(coord, {
      idempotencyKey: `m-${caseId}`,
      input: {
        caseId,
        siteId: 'site_m',
        patientId,
        sourceId: `src_${caseId}`,
        consentId,
        actionType: 'CONSULTATION',
        actionText: 'Arrange the approved consultation',
        dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        ownerId: 'u_coord',
        language: 'en-IN',
      },
    })
  ).version;
  v = (
    await cmd.approve(staff('u_rev', 'REVIEWER'), {
      caseId,
      expectedVersion: v,
      idempotencyKey: `m-${caseId}-a`,
      input: {
        sourceAuthorityRef: `src_${caseId}`,
        checkedFields: ['patient', 'action', 'dueAt', 'contact', 'owner', 'language', 'adult'],
      },
    })
  ).version;
  await cmd.dispatchContact(coord, {
    caseId,
    expectedVersion: v,
    idempotencyKey: `m-${caseId}-c`,
    input: { channel: 'WHATSAPP' },
  });
  return (
    await firestore()
      .doc(tenantRecord(T, 'cases', caseId))
      .get()
  ).data() as Case;
}

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  const db = firestore();
  const b = db.batch();
  b.set(db.doc(tenantDoc(T)), {
    tenantId: T,
    displayName: 'Mobile lab',
    timeZone: 'Asia/Kolkata',
    outreachPaused: false,
    simulation: true,
  } satisfies Tenant);
  b.set(db.doc(tenantRecord(T, 'sites', 'site_m')), {
    siteId: 'site_m',
    displayName: 'Main',
    timeZone: 'Asia/Kolkata',
    contactWindow: { start: '00:00', end: '23:59' },
  } satisfies Site);
  for (const [uid, role] of [
    ['u_coord', 'COORDINATOR'],
    ['u_rev', 'REVIEWER'],
  ] as const)
    b.set(db.doc(tenantRecord(T, 'members', uid)), {
      uid,
      displayName: uid,
      email: `${uid}@mobile.careloop.test`,
      roleSet: [role],
      status: 'ACTIVE',
      permittedSiteIds: ['site_m'],
    } satisfies Member);
  for (const p of ['pat_a', 'pat_b']) {
    b.set(db.doc(tenantRecord(T, 'patients', p)), {
      patientId: p,
      externalRef: `ref_${p}`,
      alias: p,
      contactMasked: 'x',
      ageEligibility: 'ADULT_CONFIRMED',
      language: 'en-IN',
      identityMethodRef: 'x',
    } satisfies Patient);
    b.set(db.doc(tenantRecord(T, 'consents', `con_${p}`)), {
      consentId: `con_${p}`,
      patientId: p,
      purpose: 'FOLLOW_UP_COORDINATION',
      channels: ['BROWSER_VOICE', 'WHATSAPP'],
      noticeVersion: 'v1',
      recordedBy: 'u_rev',
      proofRef: 'p',
      grantedAt: '2026-01-01T00:00:00Z',
      revokedAt: null,
      expiresAt: null,
      version: 1,
    } satisfies Consent);
  }
  for (const id of ['CL-M1', 'CL-M2'])
    b.set(db.doc(tenantRecord(T, 'sources', `src_${id}`)), {
      sourceId: `src_${id}`,
      sourceAuthority: 'clinic',
      documentType: 'FORM',
      reference: `order_${id}`,
    } satisfies Source);
  b.set(db.doc(tenantRecord(T, 'slots', 'slot_m1')), {
    slotId: 'slot_m1',
    siteId: 'site_m',
    actionType: 'CONSULTATION',
    location: 'Room 1',
    startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 86_400_000 + 1_800_000).toISOString(),
    capacity: 1,
    reserved: 0,
  });
  await b.commit();
  await setPatientWhatsApp(db, { tenantId: T, patientId: 'pat_a' }, PHONE, 'test');
  await setPatientWhatsApp(db, { tenantId: T, patientId: 'pat_b' }, OTHER, 'test');
  await approvedCase('CL-M1', 'pat_a', 'con_pat_a');
  await approvedCase('CL-M2', 'pat_b', 'con_pat_b');
});

afterAll(async () => {
  await firestore().terminate();
});

describe('patient app sign-in', () => {
  it('answers the same for an unknown number and gives it no code', async () => {
    const r = await json(await start(post({ phone: '+919800000999' })));
    expect(r.status).toBe(200);
    expect(r.body.simulatedCode).toBeUndefined();
  });

  it('a wrong code fails, a used code cannot be reused', async () => {
    const s = await json(await start(post({ phone: PHONE })));
    const code = s.body.simulatedCode as string;
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await verify(post({ phone: PHONE, code: wrong }))).status).toBe(401);
    expect((await verify(post({ phone: '98000 00101', code }))).status).toBe(200);
    expect((await verify(post({ phone: PHONE, code }))).status).toBe(401);
  });

  it('limits codes to 3 per 15 minutes per number', async () => {
    // One code already sent above for PHONE; use the other number.
    for (let i = 0; i < 3; i++) expect((await start(post({ phone: OTHER }))).status).toBe(200);
    expect((await start(post({ phone: OTHER }))).status).toBe(429);
  });
});

describe('patient app follow-ups', () => {
  let token = '';
  it('lists only this number’s follow-ups, and refuses without a session', async () => {
    expect((await me(get(), params({}))).status).toBe(401);
    token = await signIn(PHONE);
    const r = await json(await me(get(token), params({})));
    expect(r.status).toBe(200);
    expect(r.body.followUps.map((f: { ref: string }) => f.ref)).toEqual([`${T}.CL-M1`]);
    expect(r.body.followUps[0]).toMatchObject({ status: 'NOT_BOOKED', canBook: true });
    expect((await getCase(get(token), params({ ref: `${T}.CL-M2` }))).status).toBe(404);
  });

  it('books an offered time through the calendar path', async () => {
    const ref = `${T}.CL-M1`;
    const d = await json(await getCase(get(token), params({ ref })));
    expect(d.body.slots.map((s: { slotId: string }) => s.slotId)).toEqual(['slot_m1']);
    expect((await book(post({ slotId: 'slot_made_up' }, token), params({ ref }))).status).toBe(422);
    const r = await json(await book(post({ slotId: 'slot_m1' }, token), params({ ref })));
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('REQUEST_RECEIVED');
    const c = (
      await firestore()
        .doc(tenantRecord(T, 'cases', 'CL-M1'))
        .get()
    ).data() as Case;
    expect(c).toMatchObject({ workflowState: 'AWAITING_BOOKING', bookingState: 'REQUESTED' });
  });

  it('stop contact withdraws consent', async () => {
    const r = await json(
      await act(post({ action: 'STOP_CONTACT' }, token), params({ ref: `${T}.CL-M1` })),
    );
    expect(r.status).toBe(200);
    expect(r.body.automatedContact).toBe(false);
  });
});
