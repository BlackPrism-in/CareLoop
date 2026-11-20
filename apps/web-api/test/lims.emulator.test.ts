import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Case, Consent, Member, Patient, Site, Tenant } from '@careloop/contracts';
import { tenantCollection, tenantDoc, tenantRecord } from '@careloop/domain';
import { signSandboxPayload } from '@careloop/jobs';
import { firestore } from '@/server/firebase';
import { issueStatement } from '@/server/billing';
import { POST } from '../app/webhooks/lims/[account]/route';

/** LIMS order feed: signed, tenant from the account mapping, DRAFT cases only, idempotent. */
const PROJECT = 'demo-careloop-api';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST!;
const T = 't_lims';
const SECRET = 'lims-test-secret-01';

const hl7 = (orderId: string, patientRef: string) =>
  [
    'MSH|^~\\&|LIMS|HOSP|CARELOOP|CL|20261120093000||ORM^O01|M-' + orderId + '|P|2.5',
    `PID|1||${patientRef}^^^HOSP^MR`,
    `ORC|NW|${orderId}||||||||||77^Iyer^Anil`,
    `OBR|1|${orderId}||HBA1C^HbA1c repeat test^L`,
    'TQ1|1||||||20301205',
  ].join('\r');

async function send(body: string, opts: { type?: string; secret?: string; account?: string } = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const res = await POST(
    new Request('http://localhost/webhooks/lims/x', {
      method: 'POST',
      headers: {
        'content-type': opts.type ?? 'x-application/hl7-v2+er7',
        'x-careloop-signature': signSandboxPayload(opts.secret ?? SECRET, ts, body),
      },
      body,
    }),
    { params: Promise.resolve({ account: opts.account ?? 'hosp1' }) },
  );
  return {
    status: res.status,
    body: (await res.json()) as { status: string; caseId: string | null; reason: string | null },
  };
}

beforeAll(async () => {
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  const db = firestore();
  const b = db.batch();
  b.set(db.doc(tenantDoc(T)), {
    tenantId: T,
    displayName: 'LIMS lab',
    timeZone: 'Asia/Kolkata',
    outreachPaused: false,
    simulation: true,
  } satisfies Tenant);
  b.set(db.doc(tenantRecord(T, 'sites', 'site_h')), {
    siteId: 'site_h',
    displayName: 'Hospital',
    timeZone: 'Asia/Kolkata',
    contactWindow: { start: '09:00', end: '19:00' },
  } satisfies Site);
  b.set(db.doc(tenantRecord(T, 'members', 'u_rev')), {
    uid: 'u_rev',
    displayName: 'Rev',
    email: 'rev@lims.careloop.test',
    roleSet: ['REVIEWER'],
    status: 'ACTIVE',
    permittedSiteIds: ['site_h'],
  } satisfies Member);
  b.set(db.doc(tenantRecord(T, 'patients', 'pat_l')), {
    patientId: 'pat_l',
    externalRef: 'HREF-1',
    alias: 'L',
    contactMasked: '+91 •• 11',
    ageEligibility: 'ADULT_CONFIRMED',
    language: 'hi-IN',
    identityMethodRef: 'x',
  } satisfies Patient);
  b.set(db.doc(tenantRecord(T, 'consents', 'con_l')), {
    consentId: 'con_l',
    patientId: 'pat_l',
    purpose: 'FOLLOW_UP_COORDINATION',
    channels: ['BROWSER_VOICE'],
    noticeVersion: 'v1',
    recordedBy: 'u_rev',
    proofRef: 'p',
    grantedAt: '2026-01-01T00:00:00Z',
    revokedAt: null,
    expiresAt: null,
    version: 1,
  } satisfies Consent);
  b.set(db.doc('provider_accounts/lims__hosp1'), {
    tenantId: T,
    siteId: 'site_h',
    defaultOwnerId: 'u_rev',
    active: true,
  });
  await b.commit();
});

afterAll(async () => {
  await firestore().terminate();
});

describe('LIMS order intake', () => {
  it('turns a signed HL7 order into a DRAFT case at the mapped site, once', async () => {
    const r = await send(hl7('ORD-1', 'HREF-1'));
    expect(r).toMatchObject({ status: 201, body: { status: 'CREATED' } });
    const c = (
      await firestore()
        .doc(tenantRecord(T, 'cases', r.body.caseId!))
        .get()
    ).data() as Case;
    expect(c).toMatchObject({
      workflowState: 'DRAFT',
      siteId: 'site_h',
      patientId: 'pat_l',
      actionType: 'ORDERED_TEST',
      language: 'hi-IN',
      approvedAt: null,
    });
    expect(c.createdBy).toBe('lims:hosp1');
    const again = await send(hl7('ORD-1', 'HREF-1'));
    expect(again).toMatchObject({
      status: 200,
      body: { status: 'DUPLICATE', caseId: r.body.caseId },
    });
    const all = await firestore().collection(tenantCollection(T, 'cases')).get();
    expect(all.size).toBe(1);
  });

  it('accepts the JSON form and refuses a tenant in the payload', async () => {
    const order = {
      orderId: 'ORD-2',
      patientRef: 'HREF-1',
      actionType: 'CONSULTATION',
      actionText: 'Cardiology review',
      due: '2030-12-01',
      orderingAuthority: 'Dr Iyer',
    };
    expect(await send(JSON.stringify(order), { type: 'application/json' })).toMatchObject({
      status: 201,
      body: { status: 'CREATED' },
    });
    expect(
      await send(JSON.stringify({ ...order, orderId: 'ORD-3', tenantId: 'other' }), {
        type: 'application/json',
      }),
    ).toMatchObject({ status: 400 });
  });

  it('holds an order for an unknown patient for staff, without echoing it', async () => {
    const r = await send(hl7('ORD-4', 'NOPE-9'));
    expect(r).toMatchObject({
      status: 202,
      body: { status: 'NEEDS_REVIEW', reason: 'PATIENT_NOT_FOUND', caseId: null },
    });
    expect(JSON.stringify(r.body)).not.toContain('NOPE-9');
  });

  it('rejects a bad signature, an unknown account and cancel messages', async () => {
    expect((await send(hl7('ORD-5', 'HREF-1'), { secret: 'wrong' })).status).toBe(401);
    expect((await send(hl7('ORD-5', 'HREF-1'), { account: 'nobody' })).status).toBe(404);
    expect(await send(hl7('ORD-6', 'HREF-1').replace('ORC|NW', 'ORC|CA'))).toMatchObject({
      status: 400,
      body: { reason: 'ORDER_CONTROL_CA_NEEDS_STAFF' },
    });
  });

  it('bills a month once, in order, without charging unapproved drafts', async () => {
    const after = new Date('2027-01-02T00:00:00Z');
    await expect(issueStatement(T, '2027-01', 'u_rev', after)).rejects.toMatchObject({
      message: 'MONTH_NOT_ENDED',
    });
    const first = await issueStatement(T, '2026-12', 'u_rev', after);
    expect(first.created).toBe(true);
    expect(first.statement.totalInr).toBe(2999); // one site; the LIMS drafts are not enrolled yet
    expect(first.statement.caseIds).toEqual([]);
    expect((await issueStatement(T, '2026-12', 'u_rev', after)).created).toBe(false);
    await expect(issueStatement(T, '2026-11', 'u_rev', after)).rejects.toMatchObject({
      message: 'LATER_MONTH_ALREADY_ISSUED',
    });
  });
});
