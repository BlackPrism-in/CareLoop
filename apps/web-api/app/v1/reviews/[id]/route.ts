import { randomUUID } from 'node:crypto';
import { tenantRecord } from '@careloop/domain';
import { loadCase } from '@/server/case-helpers';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { ReviewBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';

/** Record a protocol review of one call (reviewer or owner). Audited; cannot be changed afterwards. */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  if (!session.ctx.roles.some((r) => r === 'REVIEWER' || r === 'OWNER'))
    throw new HttpError('FORBIDDEN', 'Only reviewers can review calls');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(params.id)) throw new HttpError('NOT_FOUND', 'Call not found');
  const body = ReviewBody.parse(await jsonBody(req));
  if (body.outcome === 'ISSUE' && body.issues.length === 0)
    throw new HttpError('VALIDATION_FAILED', 'Choose at least one issue', { issues: 'required' });
  const db = firestore();
  const ref = db.doc(tenantRecord(session.ctx.tenantId, 'interactions', params.id));
  const call = (await ref.get()).data();
  if (!call) throw new HttpError('NOT_FOUND', 'Call not found');
  await loadCase(session.ctx.tenantId, String(call.caseId), session.ctx.siteIds); // site scope
  const now = new Date().toISOString();
  const auditId = randomUUID();
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) throw new HttpError('NOT_FOUND', 'Call not found');
    if (s.data()!.reviewStatus !== 'PENDING')
      throw new HttpError(
        'VERSION_CONFLICT',
        'This call has already been reviewed or does not need review',
      );
    t.update(ref, {
      reviewStatus: 'REVIEWED',
      review: {
        outcome: body.outcome,
        issues: body.issues,
        note: body.note ?? null,
        reviewerId: session.ctx.actorId,
        at: now,
      },
    });
    t.set(db.doc(tenantRecord(session.ctx.tenantId, 'audit', auditId)), {
      auditId,
      action: 'CALL_REVIEWED',
      interactionId: params.id,
      outcome: body.outcome,
      actorId: session.ctx.actorId,
      at: now,
    });
  });
  return Response.json({ reviewed: true, outcome: body.outcome });
});
