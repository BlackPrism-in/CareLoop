import { caseSummary, loadPatientCase, mobileRoute } from '@/server/mobile';
import { jobRuntime } from '@/server/services';

export const dynamic = 'force-dynamic';

/** One follow-up, with the times the lab's calendar offers if the patient can book. */
export const GET = mobileRoute<{ ref: string }>(async ({ params, session, correlationId }) => {
  const { tenantId, c } = await loadPatientCase(session, params.ref);
  const summary = await caseSummary(tenantId, c);
  let slots: { slotId: string; startsAt: string; location: string }[] = [];
  const booking = jobRuntime().booking;
  if (summary.canBook && booking.kind !== 'manual') {
    slots = (
      await booking.listSlots(
        { tenantId, operationId: `slots-${c.caseId}`, correlationId },
        { siteId: c.siteId, actionType: c.actionType, from: new Date().toISOString(), to: c.dueAt },
      )
    ).map(({ slotId, startsAt, location }) => ({ slotId, startsAt, location }));
  }
  return Response.json({ ...summary, slots });
});
