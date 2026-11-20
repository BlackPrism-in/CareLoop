import { staffRoute } from '@/server/handler';
import { queries } from '@/server/services';

export const dynamic = 'force-dynamic';

export const GET = staffRoute(async ({ session }) => {
  const { member, ctx } = session;
  const lookups = await queries().lookups(ctx.tenantId);
  return Response.json({
    uid: member.uid,
    displayName: member.displayName,
    roles: member.roleSet,
    tenant: lookups.tenant,
    permittedSiteIds: member.permittedSiteIds,
  });
});
