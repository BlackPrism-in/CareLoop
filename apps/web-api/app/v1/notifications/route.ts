import { tenantCollection } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';

export const dynamic = 'force-dynamic';

/** The signed-in staff member's unread in-app notifications. */
export const GET = staffRoute(async ({ session }) => {
  const snap = await firestore()
    .collection(tenantCollection(session.ctx.tenantId, 'notifications'))
    .where('recipientId', '==', session.ctx.actorId)
    .where('readAt', '==', null)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  return Response.json({ items: snap.docs.map((d) => d.data()) });
});
