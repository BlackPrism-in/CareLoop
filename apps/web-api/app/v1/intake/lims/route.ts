import { tenantCollection } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';
import type { LimsInboxDoc } from '@/server/lims';

export const dynamic = 'force-dynamic';

/** LIMS orders held for staff (unknown patient, no consent, cancel/changes). */
export const GET = staffRoute(async ({ session }) => {
  if (!session.ctx.roles.some((r) => r === 'COORDINATOR' || r === 'REVIEWER' || r === 'OWNER'))
    throw new HttpError('FORBIDDEN', 'Not permitted');
  const snap = await firestore()
    .collection(tenantCollection(session.ctx.tenantId, 'lims_inbox'))
    .where('status', '==', 'NEEDS_REVIEW')
    .limit(100)
    .get();
  const items = snap.docs
    .map((d) => d.data() as LimsInboxDoc)
    .map(({ rawHash: _h, ...rest }) => rest)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return Response.json({ items });
});
