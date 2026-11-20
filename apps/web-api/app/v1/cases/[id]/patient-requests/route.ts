import { HttpError } from '@/server/errors';
import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { PatientRequestBody } from '@/server/schemas';
import { caseCommands, kick, queries } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * A coordinator records the patient's explicit request after a staff-handled
 * contact. In a synthetic lab the identity step is labelled simulated; real
 * identity methods are agreed with the lab before a pilot (MVP spec §07).
 */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params, correlationId }) => {
  const key = idempotencyKey(req);
  const body = PatientRequestBody.parse(await jsonBody(req));
  const tenant = (await queries().lookups(session.ctx.tenantId, session.ctx.siteIds)).tenant;
  if (!tenant) throw new HttpError('NOT_FOUND', 'Lab not found');
  if (!tenant.simulation)
    throw new HttpError('DOMAIN_GUARD_FAILED', 'IDENTITY_METHOD_NOT_CONFIGURED');
  const result = await caseCommands().recordPatientRequest(session.ctx, {
    caseId: params.id,
    expectedVersion: body.expectedVersion,
    idempotencyKey: key,
    input: {
      interactionId: `staff-${correlationId}`,
      identityAssurance: 'SIMULATED',
      request: body.request,
    },
  });
  await kick(session.ctx.tenantId, params.id);
  return Response.json(result);
});
