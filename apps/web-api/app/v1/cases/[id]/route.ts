import { HttpError } from '@/server/errors';
import { staffRoute } from '@/server/handler';
import { jobQueries, queries } from '@/server/services';

export const dynamic = 'force-dynamic';

export const GET = staffRoute<{ id: string }>(async ({ session, params }) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.id)) throw new HttpError('NOT_FOUND', 'Case not found');
  const detail = await queries().caseDetail(session.ctx.tenantId, params.id);
  // Cross-tenant ids are indistinguishable from missing ones.
  if (!detail) throw new HttpError('NOT_FOUND', 'Case not found');
  const bookings = await jobQueries().bookingsForCase(session.ctx.tenantId, params.id);
  return Response.json({ ...detail, bookings });
});
