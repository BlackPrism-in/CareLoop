import { HttpError } from '@/server/errors';
import { staffRoute } from '@/server/handler';
import { jobRuntime, queries } from '@/server/services';

export const dynamic = 'force-dynamic';

/** Available slots come only from the booking adapter (MVP spec §17), from now until the due date. */
export const GET = staffRoute<{ id: string }>(async ({ session, params }) => {
  const detail = await queries().caseDetail(session.ctx.tenantId, params.id, session.ctx.siteIds);
  if (!detail) throw new HttpError('NOT_FOUND', 'Case not found');
  const c = detail.case;
  const booking = jobRuntime().booking;
  const slots = await booking.listSlots(
    {
      tenantId: session.ctx.tenantId,
      operationId: `slots-${c.caseId}`,
      correlationId: session.ctx.correlationId,
    },
    { siteId: c.siteId, actionType: c.actionType, from: new Date().toISOString(), to: c.dueAt },
  );
  return Response.json({ adapter: booking.kind, slots, simulation: booking.kind === 'sandbox' });
});
