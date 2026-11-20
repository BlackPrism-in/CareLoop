import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { EditDraftBody } from '@/server/schemas';
import { caseCommands } from '@/server/services';

export const dynamic = 'force-dynamic';

/** Material edits after approval invalidate it (case returns to DRAFT). */
export const PATCH = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  const key = idempotencyKey(req);
  const body = EditDraftBody.parse(await jsonBody(req));
  const result = await caseCommands().editDraft(session.ctx, {
    caseId: params.id,
    expectedVersion: body.expectedVersion,
    idempotencyKey: key,
    input: body.edit,
  });
  return Response.json(result);
});
