import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { ManualConfirmBody } from '@/server/schemas';
import { caseCommands, jobQueries, queries } from '@/server/services';
import { tenantRecord } from '@careloop/domain';

export const dynamic = 'force-dynamic';

/**
 * Manual adapter: a coordinator enters the real external reference and the
 * confirmed time after booking it outside CareLoop. Attributed to them and
 * shown with a manual-confirmation badge (MVP spec §17).
 */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  const key = idempotencyKey(req);
  const body = ManualConfirmBody.parse(await jsonBody(req));
  const b = await jobQueries().booking(session.ctx.tenantId, params.id);
  if (!b) throw new HttpError('NOT_FOUND', 'Booking not found');
  if (b.status !== 'PENDING_STAFF')
    throw new HttpError('DOMAIN_GUARD_FAILED', 'BOOKING_NOT_AWAITING_STAFF');
  const simulation = (await queries().lookups(session.ctx.tenantId, session.ctx.siteIds)).tenant?.simulation ?? false;
  const result = await caseCommands().confirmBooking(session.ctx, {
    caseId: b.caseId,
    expectedVersion: body.expectedVersion,
    idempotencyKey: key,
    input: {
      externalRef: body.externalRef,
      startsAt: body.startsAt,
      adapter: 'manual',
      simulation,
    },
  });
  await firestore()
    .doc(tenantRecord(session.ctx.tenantId, 'bookings', b.bookingId))
    .update({
      status: 'CONFIRMED',
      externalRef: body.externalRef,
      startsAt: body.startsAt,
      confirmedBy: session.ctx.actorId,
      simulation,
      updatedAt: new Date().toISOString(),
    });
  return Response.json(result);
});
