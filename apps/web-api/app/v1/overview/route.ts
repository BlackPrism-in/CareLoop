import { staffRoute } from '@/server/handler';
import { queries } from '@/server/services';

export const dynamic = 'force-dynamic';

export const GET = staffRoute(async ({ session }) => {
  const counts = await queries().overview(session.ctx.tenantId, session.ctx.actorId);
  return Response.json({ counts, asOf: new Date().toISOString() });
});
