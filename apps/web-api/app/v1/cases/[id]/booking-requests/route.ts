import { HttpError } from '@/server/errors';
import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { BookingRequestBody, STAFF_ARRANGED } from '@/server/schemas';
import { caseCommands, jobRuntime, kick, queries } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * Reserves a booking operation for a slot the adapter actually offered and the
 * patient explicitly confirmed (MVP-04). Returns 202: the reservation itself
 * happens in the worker, and the case becomes BOOKED only on acknowledgment.
 */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  const key = idempotencyKey(req);
  const body = BookingRequestBody.parse(await jsonBody(req));
  const detail = await queries().caseDetail(session.ctx.tenantId, params.id);
  if (!detail) throw new HttpError('NOT_FOUND', 'Case not found');
  const booking = jobRuntime().booking;
  if (booking.kind === 'manual') {
    if (body.slotId !== STAFF_ARRANGED)
      throw new HttpError('DOMAIN_GUARD_FAILED', 'SLOT_NOT_OFFERED_BY_ADAPTER');
  } else {
    const c = detail.case;
    const offered = await booking.listSlots(
      {
        tenantId: session.ctx.tenantId,
        operationId: `slots-${c.caseId}`,
        correlationId: session.ctx.correlationId,
      },
      { siteId: c.siteId, actionType: c.actionType, from: new Date().toISOString(), to: c.dueAt },
    );
    if (!offered.some((s) => s.slotId === body.slotId))
      throw new HttpError('DOMAIN_GUARD_FAILED', 'SLOT_NOT_OFFERED_BY_ADAPTER');
  }
  const result = await caseCommands().requestBooking(session.ctx, {
    caseId: params.id,
    expectedVersion: body.expectedVersion,
    idempotencyKey: key,
    input: { slotId: body.slotId, patientConfirmedSlot: body.patientConfirmedSlot },
  });
  await kick(session.ctx.tenantId, params.id);
  return Response.json(result, { status: 202 });
});
