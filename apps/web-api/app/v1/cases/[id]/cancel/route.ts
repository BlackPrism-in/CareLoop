import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { ReasonBody } from '@/server/schemas';
import { caseCommands, kick } from '@/server/services';

export const dynamic = 'force-dynamic';

/** Authorized cancel with a reason; history and evidence are preserved. */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  const key = idempotencyKey(req);
  const body = ReasonBody.parse(await jsonBody(req));
  const result = await caseCommands().cancelCase(session.ctx, {
    caseId: params.id,
    expectedVersion: body.expectedVersion,
    idempotencyKey: key,
    input: { reason: body.reason },
  });
  await kick(session.ctx.tenantId, params.id);
  return Response.json(result);
});
