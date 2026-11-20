import { HttpError } from '@/server/errors';
import { jsonBody } from '@/server/handler';
import { caseSummary, loadPatientCase, mobileRoute, patientCtx } from '@/server/mobile';
import { MobileBookBody } from '@/server/schemas';
import { caseCommands, jobRuntime, kick } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * The patient picks one of the offered times. Same path as a booking made on a
 * call: the slot must come from the calendar, and the case is BOOKED only when
 * the calendar acknowledges (202 until then).
 */
export const POST = mobileRoute<{ ref: string }>(
  async ({ req, params, session, correlationId }) => {
    const { slotId } = MobileBookBody.parse(await jsonBody(req));
    let { tenantId, c } = await loadPatientCase(session, params.ref);
    if (!(await caseSummary(tenantId, c)).canBook)
      throw new HttpError('DOMAIN_GUARD_FAILED', 'This follow-up cannot be booked in the app now.');
    const offered = await jobRuntime().booking.listSlots(
      { tenantId, operationId: `slots-${c.caseId}`, correlationId },
      { siteId: c.siteId, actionType: c.actionType, from: new Date().toISOString(), to: c.dueAt },
    );
    if (!offered.some((s) => s.slotId === slotId))
      throw new HttpError('DOMAIN_GUARD_FAILED', 'That time is no longer available.');
    const ctx = patientCtx(tenantId, c.patientId, correlationId);
    const cmd = caseCommands();
    const key = `app:${session.sessionHash.slice(0, 16)}:${c.caseId}:${slotId}`;
    let version = c.version;
    if (c.workflowState === 'CONTACTING') {
      version = (
        await cmd.recordPatientRequest(ctx, {
          caseId: c.caseId,
          expectedVersion: version,
          idempotencyKey: `${key}:ask`,
          input: {
            interactionId: `app-${session.sessionHash.slice(0, 16)}`,
            identityAssurance: 'PHONE_OTP',
            request: 'BOOK',
          },
        })
      ).version;
    }
    await cmd.requestBooking(ctx, {
      caseId: c.caseId,
      expectedVersion: version,
      idempotencyKey: `${key}:book`,
      input: { slotId, patientConfirmedSlot: true },
    });
    await kick(tenantId, c.caseId);
    ({ c } = await loadPatientCase(session, params.ref));
    return Response.json(await caseSummary(tenantId, c), { status: 202 });
  },
);
