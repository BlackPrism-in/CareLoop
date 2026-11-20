import { HttpError } from '@/server/errors';
import { staffRoute } from '@/server/handler';
import { jobQueries } from '@/server/services';

export const dynamic = 'force-dynamic';

export const GET = staffRoute<{ id: string }>(async ({ session, params }) => {
  if (!/^[a-f0-9]{64}$/.test(params.id)) throw new HttpError('NOT_FOUND', 'Operation not found');
  const op = await jobQueries().operation(session.ctx.tenantId, params.id);
  if (!op) throw new HttpError('NOT_FOUND', 'Operation not found');
  return Response.json(op);
});
