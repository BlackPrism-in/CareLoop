import { randomUUID } from 'node:crypto';
import { tenantDoc, tenantRecord } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { OutreachPauseBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';

/**
 * Owner-only site pause (MVP spec §05). Stops future dispatch at execution
 * time; evidence ingestion and staff work continue. Audited with a reason.
 */
export const POST = staffRoute(async ({ req, session }) => {
  if (!session.ctx.roles.includes('OWNER'))
    throw new HttpError('FORBIDDEN', 'Only an owner can pause outreach');
  const { paused, reason } = OutreachPauseBody.parse(await jsonBody(req));
  const db = firestore();
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.update(db.doc(tenantDoc(session.ctx.tenantId)), { outreachPaused: paused });
  const id = randomUUID();
  batch.set(db.doc(tenantRecord(session.ctx.tenantId, 'audit', id)), {
    auditId: id,
    action: paused ? 'OUTREACH_PAUSED' : 'OUTREACH_RESUMED',
    reason,
    actorId: session.ctx.actorId,
    at: now,
    correlationId: session.ctx.correlationId,
  });
  await batch.commit();
  return Response.json({ outreachPaused: paused, at: now });
});
