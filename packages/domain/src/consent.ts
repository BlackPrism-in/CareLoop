import type { Firestore } from 'firebase-admin/firestore';
import type { Case, Consent } from '@careloop/contracts';
import type { ActorContext } from './context';
import { DomainError, notFound } from './errors';
import { tenantCollection, tenantRecord } from './paths';
import type { CaseCommands } from './service';

/**
 * Withdraws consent (MVP-07). The consent record is updated first, so every
 * execution-time check (dispatch, booking worker) denies contact from that
 * moment. Each open case using it is then marked OPTED_OUT, which also queues
 * suppression of pending work. Obligations themselves are not cancelled.
 */
export async function revokeConsent(
  db: Firestore,
  commands: CaseCommands,
  ctx: ActorContext,
  input: { consentId: string; reason: string },
  now = new Date(),
): Promise<{ revoked: boolean; casesSuppressed: string[] }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.consentId)) throw notFound('CONSENT');
  const ref = db.doc(tenantRecord(ctx.tenantId, 'consents', input.consentId));
  const revoked = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw notFound('CONSENT');
    const k = snap.data() as Consent;
    if (k.revokedAt) return false;
    t.update(ref, {
      revokedAt: now.toISOString(),
      version: k.version + 1,
      revokedBy: ctx.actorId,
      revokedReason: input.reason.slice(0, 300),
    });
    return true;
  });
  const cases = (
    await db
      .collection(tenantCollection(ctx.tenantId, 'cases'))
      .where('consentId', '==', input.consentId)
      .limit(50)
      .get()
  ).docs.map((d) => d.data() as Case);
  const suppressed: string[] = [];
  for (const c of cases) {
    if (
      ['CANCELLED', 'COMPLETED_VERIFIED'].includes(c.workflowState) ||
      c.outreachDisposition === 'OPTED_OUT'
    )
      continue;
    try {
      await commands.optOut(ctx, {
        caseId: c.caseId,
        expectedVersion: c.version,
        idempotencyKey: `consent-revoke:${input.consentId}:${c.caseId}`,
        input: { channel: 'ALL' },
      });
      suppressed.push(c.caseId);
    } catch (e) {
      // Suppression is already in force through the consent record; a racing change is fine.
      if (!(e instanceof DomainError)) throw e;
    }
  }
  return { revoked, casesSuppressed: suppressed };
}
