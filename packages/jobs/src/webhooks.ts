import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { NormalizedProviderEvent, type Case } from '@careloop/contracts';
import { sha256, tenantCollection, tenantRecord } from '@careloop/domain';
import type { Logger } from '@careloop/observability';
import type { OutboxDispatcher } from './dispatcher';
import type { OutboxDoc } from './types';

export const SIGNATURE_HEADER = 'x-careloop-signature';
const REPLAY_WINDOW_S = 300;

export interface InboxDoc {
  inboxId: string;
  provider: string;
  account: string;
  tenantId: string;
  caseId: string | null;
  event: NormalizedProviderEvent;
  rawHash: string;
  receivedAt: string;
  status: 'RECEIVED' | 'UNMATCHED' | 'PROCESSED' | 'NEEDS_REVIEW' | 'STALE';
  detail: string | null;
}

/** Signature for the sandbox provider: HMAC-SHA256 over "<timestamp>.<raw body>". */
export function signSandboxPayload(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

/** Checks a "t=<unix>,v1=<hex hmac>" signature over the raw body within the replay window. */
export function verifySignedPayload(
  secret: string,
  header: string | null,
  rawBody: string,
  now: Date,
): 'OK' | 'MISSING' | 'STALE' | 'BAD' {
  if (!header) return 'MISSING';
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2) as [string, string]),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return 'BAD';
  if (Math.abs(now.getTime() / 1000 - t) > REPLAY_WINDOW_S) return 'STALE';
  const expected = Buffer.from(signSandboxPayload(secret, t, rawBody).split('v1=')[1]!, 'hex');
  const got = Buffer.from(parts.v1, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected) ? 'OK' : 'BAD';
}

export interface IngestResult {
  httpStatus: 202 | 200 | 400 | 401 | 404;
  status: 'ACCEPTED' | 'DUPLICATE' | 'UNMATCHED' | 'REJECTED';
  reason?: string;
}

/**
 * Provider callback ingestion (MVP spec §14–15): verify the signature over the
 * raw payload and a replay window → map the account to a tenant server-side
 * (never from the payload) → durable inbox record keyed by the provider event
 * id (duplicates are acknowledged once) → asynchronous processing via the
 * outbox. A valid signature proves origin, not that the evidence matches.
 */
export async function ingestProviderWebhook(
  deps: {
    db: Firestore;
    secrets: Record<string, string>;
    dispatcher: OutboxDispatcher;
    log: Logger;
    clock?: () => Date;
  },
  req: { provider: string; account: string; rawBody: string; signature: string | null },
): Promise<IngestResult> {
  const now = (deps.clock ?? (() => new Date()))();
  const key = `${req.provider}:${req.account}`;
  const secret = deps.secrets[key];
  if (req.provider !== 'sandbox' || !secret || !/^[A-Za-z0-9_-]{1,64}$/.test(req.account)) {
    return { httpStatus: 404, status: 'REJECTED', reason: 'UNKNOWN_ACCOUNT' };
  }
  const sig = verifySignedPayload(secret, req.signature, req.rawBody, now);
  if (sig !== 'OK') {
    deps.log.warn('webhook signature rejected', {
      provider: req.provider,
      account: req.account,
      result: sig,
    });
    return { httpStatus: 401, status: 'REJECTED', reason: `SIGNATURE_${sig}` };
  }
  let event: NormalizedProviderEvent;
  try {
    event = NormalizedProviderEvent.parse(JSON.parse(req.rawBody));
  } catch {
    return { httpStatus: 400, status: 'REJECTED', reason: 'INVALID_PAYLOAD' };
  }
  const mapping = (
    await deps.db.doc(`provider_accounts/${req.provider}__${req.account}`).get()
  ).data() as { tenantId?: string; active?: boolean } | undefined;
  if (!mapping?.tenantId || mapping.active === false)
    return { httpStatus: 404, status: 'REJECTED', reason: 'UNKNOWN_ACCOUNT' };
  const tenantId = mapping.tenantId;

  // Find the case: by booking reference first, else the patient's single open obligation.
  let caseId: string | null = null;
  if (event.externalBookingRef) {
    const b = await deps.db
      .collection(tenantCollection(tenantId, 'bookings'))
      .where('externalRef', '==', event.externalBookingRef)
      .limit(1)
      .get();
    caseId = (b.docs[0]?.data().caseId as string | undefined) ?? null;
  }
  if (!caseId) {
    const p = await deps.db
      .collection(tenantCollection(tenantId, 'patients'))
      .where('externalRef', '==', event.patientExternalRef)
      .limit(1)
      .get();
    const patientId = p.docs[0]?.id;
    if (patientId) {
      const open = (
        await deps.db
          .collection(tenantCollection(tenantId, 'cases'))
          .where('patientId', '==', patientId)
          .limit(20)
          .get()
      ).docs
        .map((d) => d.data() as Case)
        .filter((c) => !['DRAFT', 'CANCELLED', 'COMPLETED_VERIFIED'].includes(c.workflowState));
      if (open.length === 1) caseId = open[0]!.caseId;
    }
  }

  const inboxId = `${req.provider}__${req.account}__${sha256(event.eventId).slice(0, 32)}`;
  const inboxRef = deps.db.doc(tenantRecord(tenantId, 'inbox', inboxId));
  const ts = now.toISOString();
  const created = await deps.db.runTransaction(async (t) => {
    if ((await t.get(inboxRef)).exists) return false;
    const doc: InboxDoc = {
      inboxId,
      provider: req.provider,
      account: req.account,
      tenantId,
      caseId,
      event,
      rawHash: sha256(req.rawBody),
      receivedAt: ts,
      status: caseId ? 'RECEIVED' : 'UNMATCHED',
      detail: caseId ? null : 'NO_MATCHING_CASE',
    };
    t.create(inboxRef, doc);
    if (caseId) {
      const outbox: OutboxDoc = {
        outboxId: `in_${sha256(inboxId).slice(0, 40)}`,
        tenantId,
        caseId,
        caseVersion: 0,
        operationId: sha256(inboxId),
        correlationId: `webhook-${inboxId}`,
        kind: 'PROVIDER_EVENT',
        payload: { inboxId },
        status: 'PENDING',
        attempts: 0,
        createdAt: ts,
      };
      t.create(deps.db.doc(tenantRecord(tenantId, 'outbox', outbox.outboxId)), outbox);
    }
    return true;
  });
  if (!created) return { httpStatus: 200, status: 'DUPLICATE' };
  if (!caseId) return { httpStatus: 202, status: 'UNMATCHED' };
  await deps.dispatcher.dispatchCase(tenantId, caseId);
  return { httpStatus: 202, status: 'ACCEPTED' };
}
