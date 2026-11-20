import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Consent, Patient } from '@careloop/contracts';
import { loadConfig } from '@careloop/contracts';
import {
  consentIsActive,
  LimsOrder,
  limsDueAt,
  parseHl7Orm,
  sha256,
  tenantCollection,
  tenantRecord,
  type ActorContext,
} from '@careloop/domain';
import { verifySignedPayload } from '@careloop/jobs';
import { firestore } from './firebase';
import { caseCommands, queries } from './services';

export interface LimsAccount {
  tenantId: string;
  siteId: string;
  /** Staff member who owns cases created from this feed until a reviewer reassigns them. */
  defaultOwnerId: string;
  active?: boolean;
}

export interface LimsInboxDoc {
  inboxId: string;
  account: string;
  orderId: string;
  messageId: string | null;
  format: 'JSON' | 'HL7V2';
  rawHash: string;
  status: 'CREATED' | 'NEEDS_REVIEW';
  reason: string | null;
  caseId: string | null;
  receivedAt: string;
}

export type LimsResult = { http: 200 | 201 | 202 | 400 | 401 | 404; status: string; caseId?: string | null; reason?: string };

/**
 * Signed LIMS/hospital order intake. The tenant and site come from the
 * account mapping (provider_accounts/lims__{account}), never from the
 * message. Every accepted order is stored once in the lims_inbox; a matched
 * order becomes a DRAFT case for review, an unmatched one waits for staff.
 * Responses never echo patient data.
 */
export async function ingestLimsOrder(req: {
  account: string;
  rawBody: string;
  contentType: string;
  signature: string | null;
  now?: Date;
}): Promise<LimsResult> {
  const now = req.now ?? new Date();
  const secret = loadConfig().WEBHOOK_SIGNING_SECRETS[`lims:${req.account}`];
  if (!secret || !/^[A-Za-z0-9_-]{1,64}$/.test(req.account)) return { http: 404, status: 'REJECTED', reason: 'UNKNOWN_ACCOUNT' };
  const sig = verifySignedPayload(secret, req.signature, req.rawBody, now);
  if (sig !== 'OK') return { http: 401, status: 'REJECTED', reason: `SIGNATURE_${sig}` };

  const db = firestore();
  const acct = (await db.doc(`provider_accounts/lims__${req.account}`).get()).data() as LimsAccount | undefined;
  if (!acct?.tenantId || acct.active === false) return { http: 404, status: 'REJECTED', reason: 'UNKNOWN_ACCOUNT' };

  const hl7 = /hl7/i.test(req.contentType) || req.rawBody.trimStart().startsWith('MSH');
  let order: LimsOrder;
  if (hl7) {
    const r = parseHl7Orm(req.rawBody);
    if (!r.ok) return { http: 400, status: 'REJECTED', reason: r.error };
    order = r.order;
  } else {
    let json: unknown;
    try {
      json = JSON.parse(req.rawBody);
    } catch {
      return { http: 400, status: 'REJECTED', reason: 'INVALID_JSON' };
    }
    const r = LimsOrder.safeParse(json);
    if (!r.success) return { http: 400, status: 'REJECTED', reason: `INVALID_${String(r.error.issues[0]?.path[0] ?? 'ORDER').toUpperCase()}` };
    order = r.data;
  }
  const dueAt = limsDueAt(order.due);
  if (!dueAt) return { http: 400, status: 'REJECTED', reason: 'INVALID_DUE' };

  const t = acct.tenantId;
  const inboxId = sha256(`${req.account}:${order.orderId}`).slice(0, 40);
  const inboxRef = db.doc(tenantRecord(t, 'lims_inbox', inboxId));
  const prior = (await inboxRef.get()).data() as LimsInboxDoc | undefined;
  if (prior?.status === 'CREATED') return { http: 200, status: 'DUPLICATE', caseId: prior.caseId };

  const record = (status: LimsInboxDoc['status'], reason: string | null, caseId: string | null): LimsInboxDoc => ({
    inboxId,
    account: req.account,
    orderId: order.orderId,
    messageId: order.messageId ?? null,
    format: hl7 ? 'HL7V2' : 'JSON',
    rawHash: sha256(req.rawBody),
    status,
    reason,
    caseId,
    receivedAt: prior?.receivedAt ?? now.toISOString(),
  });

  const p = await db.collection(tenantCollection(t, 'patients')).where('externalRef', '==', order.patientRef).limit(2).get();
  if (p.size !== 1) {
    await inboxRef.set(record('NEEDS_REVIEW', p.size ? 'PATIENT_AMBIGUOUS' : 'PATIENT_NOT_FOUND', null));
    return { http: 202, status: 'NEEDS_REVIEW', reason: p.size ? 'PATIENT_AMBIGUOUS' : 'PATIENT_NOT_FOUND' };
  }
  const patient = p.docs[0]!.data() as Patient;
  const consents = await db.collection(tenantCollection(t, 'consents')).where('patientId', '==', patient.patientId).limit(20).get();
  const consent = consents.docs.map((d) => d.data() as Consent).find((k) => consentIsActive(k, now));
  if (!consent) {
    await inboxRef.set(record('NEEDS_REVIEW', 'NO_ACTIVE_CONSENT', null));
    return { http: 202, status: 'NEEDS_REVIEW', reason: 'NO_ACTIVE_CONSENT' };
  }

  const ctx: ActorContext = {
    tenantId: t,
    actorType: 'SYSTEM',
    actorId: `lims:${req.account}`,
    roles: [],
    correlationId: randomUUID(),
  };
  const sourceId = await queries().ensureSource(t, { sourceAuthority: order.orderingAuthority, reference: order.orderId });
  try {
    const res = await caseCommands().createCase(ctx, {
      idempotencyKey: `lims:${req.account}:${order.orderId}`,
      input: {
        caseId: `CL-L${sha256(`${t}:${req.account}:${order.orderId}`).slice(0, 8).toUpperCase()}`,
        siteId: acct.siteId,
        patientId: patient.patientId,
        sourceId,
        consentId: consent.consentId,
        actionType: order.actionType,
        actionText: order.actionText,
        dueAt: dueAt.toISOString(),
        ownerId: acct.defaultOwnerId,
        language: patient.language,
      },
    });
    await inboxRef.set(record('CREATED', res.warnings[0] ?? null, res.caseId));
    return { http: 201, status: res.warnings.length ? 'EXISTING' : 'CREATED', caseId: res.caseId };
  } catch (e) {
    const reason = (e as { reason?: string }).reason ?? 'CREATE_FAILED';
    await inboxRef.set(record('NEEDS_REVIEW', reason, null));
    return { http: 202, status: 'NEEDS_REVIEW', reason };
  }
}
