import { loadCase } from '@/server/case-helpers';
import { HttpError } from '@/server/errors';
import { staffRoute } from '@/server/handler';
import { jobQueries } from '@/server/services';

export const dynamic = 'force-dynamic';

export const GET = staffRoute<{ id: string }>(async ({ session, params }) => {
  if (!/^[a-f0-9]{64}$/.test(params.id)) throw new HttpError('NOT_FOUND', 'Operation not found');
  const op = await jobQueries().operation(session.ctx.tenantId, params.id);
  if (!op) throw new HttpError('NOT_FOUND', 'Operation not found');
  await loadCase(session.ctx.tenantId, op.caseId, session.ctx.siteIds); // site scope
  return Response.json(op);
});
