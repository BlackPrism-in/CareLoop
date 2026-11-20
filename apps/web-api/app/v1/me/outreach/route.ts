import type { Tenant } from '@careloop/contracts';
import { tenantDoc, tenantRecord, usageMonth } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';

export const dynamic = 'force-dynamic';

export const GET = staffRoute(async ({ session }) => {
  const db = firestore();
  const t = (await db.doc(tenantDoc(session.ctx.tenantId)).get()).data() as Tenant | undefined;
  if (!t) return Response.json({ tenant: null });
  const month = usageMonth(new Date(), t.timeZone);
  const usage = (await db.doc(tenantRecord(session.ctx.tenantId, 'usage', month)).get()).data() ?? {
    contactAttempts: 0,
    voiceSeconds: 0,
  };
  return Response.json({
    tenant: { outreachPaused: t.outreachPaused, limits: t.limits ?? null },
    usage: { month, ...usage },
  });
});
