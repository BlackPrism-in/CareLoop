import { loadHandoff } from '@/server/case-helpers';
import { HttpError } from '@/server/errors';
import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { HandoffActionBody } from '@/server/schemas';
import { caseCommands, kick } from '@/server/services';

export const dynamic = 'force-dynamic';

/** acknowledge | resolve | reassign. Acknowledging or resolving never completes the follow-up (MVP-11). */
export const POST = staffRoute<{ id: string; action: string }>(async ({ req, session, params }) => {
  const key = idempotencyKey(req);
  const body = HandoffActionBody.parse(await jsonBody(req));
  const h = await loadHandoff(session.ctx.tenantId, params.id);
  const base = { caseId: h.caseId, expectedVersion: body.expectedVersion, idempotencyKey: key };
  const cmd = caseCommands();
  let result;
  switch (params.action) {
    case 'acknowledge':
      result = await cmd.acknowledgeHandoff(session.ctx, { ...base, input: {} });
      break;
    case 'resolve':
      if (!body.resolution)
        throw new HttpError('VALIDATION_FAILED', 'Resolution is required', {
          resolution: 'required',
        });
      result = await cmd.resolveHandoff(session.ctx, {
        ...base,
        input: { resolution: body.resolution, resumeAutomation: body.resumeAutomation ?? false },
      });
      break;
    case 'reassign':
      if (!body.ownerId)
        throw new HttpError('VALIDATION_FAILED', 'Owner is required', { ownerId: 'required' });
      result = await cmd.reassignHandoff(session.ctx, {
        ...base,
        input: { ownerId: body.ownerId },
      });
      break;
    default:
      throw new HttpError('NOT_FOUND', 'Unknown action');
  }
  await kick(session.ctx.tenantId, h.caseId);
  return Response.json(result);
});
