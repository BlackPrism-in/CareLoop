import { HttpError } from '@/server/errors';
import { staffRoute } from '@/server/handler';
import { filterBySite } from '@/server/case-helpers';
import { jobQueries } from '@/server/services';

export const dynamic = 'force-dynamic';

/** Recovery dashboard data (MVP spec §16): jobs that stopped retrying and need a person. */
export const GET = staffRoute(async ({ session }) => {
  if (!session.ctx.roles.some((r) => ['OWNER', 'COORDINATOR', 'AUDITOR'].includes(r)))
    throw new HttpError('FORBIDDEN', 'Not permitted');
  return Response.json({
    items: await filterBySite(
      session.ctx.tenantId,
      await jobQueries().failedJobs(session.ctx.tenantId),
      session.ctx.siteIds,
    ),
  });
});
