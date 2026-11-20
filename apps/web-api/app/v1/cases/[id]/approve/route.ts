import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { ApproveBody } from '@/server/schemas';
import { caseCommands } from '@/server/services';

export const dynamic = 'force-dynamic';

/** MVP-02: reviewer-only; reviewer identity comes from the session. */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  const key = idempotencyKey(req);
  const body = ApproveBody.parse(await jsonBody(req));
  const result = await caseCommands().approve(session.ctx, {
    caseId: params.id,
    expectedVersion: body.expectedVersion,
    idempotencyKey: key,
    input: { sourceAuthorityRef: body.sourceAuthorityRef, checkedFields: body.checkedFields },
  });
  return Response.json(result);
});
