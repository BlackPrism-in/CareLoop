import { loadCase } from '@/server/case-helpers';
import { HttpError } from '@/server/errors';
import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { CancelBookingBody } from '@/server/schemas';
import { caseCommands, jobQueries, kick } from '@/server/services';

export const dynamic = 'force-dynamic';

/** Cancellation is an operation: the booking stays confirmed until the adapter acknowledges. */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  const key = idempotencyKey(req);
  const body = CancelBookingBody.parse(await jsonBody(req));
  const b = await jobQueries().booking(session.ctx.tenantId, params.id);
  if (!b) throw new HttpError('NOT_FOUND', 'Booking not found');
  await loadCase(session.ctx.tenantId, b.caseId, session.ctx.siteIds).catch(() => {
    throw new HttpError('NOT_FOUND', 'Booking not found');
  });
  if (b.status !== 'CONFIRMED' || !b.externalRef)
    throw new HttpError('DOMAIN_GUARD_FAILED', 'NO_CONFIRMED_BOOKING');
  const result = await caseCommands().requestBookingCancellation(session.ctx, {
    caseId: b.caseId,
    expectedVersion: body.expectedVersion,
    idempotencyKey: key,
    input: { externalRef: b.externalRef, reason: body.reason },
  });
  await kick(session.ctx.tenantId, b.caseId);
  return Response.json(result, { status: 202 });
});
