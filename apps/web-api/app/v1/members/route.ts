import type { Member } from '@careloop/contracts';
import { tenantCollection } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';

export const dynamic = 'force-dynamic';

/** Owner-only staff list with roles and site assignments (no email). */
export const GET = staffRoute(async ({ session }) => {
  if (!session.ctx.roles.includes('OWNER'))
    throw new HttpError('FORBIDDEN', 'Only an owner can list staff');
  const snap = await firestore()
    .collection(tenantCollection(session.ctx.tenantId, 'members'))
    .limit(200)
    .get();
  const items = snap.docs.map((d) => {
    const m = d.data() as Member;
    return {
      uid: m.uid,
      displayName: m.displayName,
      roleSet: m.roleSet,
      status: m.status,
      permittedSiteIds: m.permittedSiteIds,
    };
  });
  return Response.json({ items });
});
