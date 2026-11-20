import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { ContactRequestBody } from '@/server/schemas';
import { caseCommands, kick } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * Schedules an allowed contact attempt (MVP spec §15). Never dials from the
 * HTTP request; all eligibility is re-checked by the command at execution time.
 */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  const key = idempotencyKey(req);
  const body = ContactRequestBody.parse(await jsonBody(req));
  const result = await caseCommands().dispatchContact(session.ctx, {
    caseId: params.id,
    expectedVersion: body.expectedVersion,
    idempotencyKey: key,
    input: { channel: body.channel },
  });
  await kick(session.ctx.tenantId, params.id);
  return Response.json(result, { status: 202 });
});
