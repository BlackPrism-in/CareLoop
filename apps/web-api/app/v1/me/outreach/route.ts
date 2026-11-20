import type { Tenant } from '@careloop/contracts';
import { tenantDoc } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';

export const dynamic = 'force-dynamic';

export const GET = staffRoute(async ({ session }) => {
  const t = (await firestore().doc(tenantDoc(session.ctx.tenantId)).get()).data() as
    Tenant | undefined;
  return Response.json({ tenant: t ? { outreachPaused: t.outreachPaused } : null });
});
