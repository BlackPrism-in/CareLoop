import { tenantCollection } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';
import { filterBySite } from '@/server/case-helpers';

export const dynamic = 'force-dynamic';

/**
 * Supervised review queue (Blueprint p.9: review the first live interactions
 * under an agreed protocol). No transcript is stored, so reviewers record what
 * the supervising staff member observed, alongside the call's tool log and
 * safety events.
 */
export const GET = staffRoute(async ({ session }) => {
  if (!session.ctx.roles.some((r) => ['REVIEWER', 'OWNER', 'AUDITOR'].includes(r)))
    throw new HttpError('FORBIDDEN', 'Not permitted');
  const snap = await firestore()
    .collection(tenantCollection(session.ctx.tenantId, 'interactions'))
    .where('reviewStatus', 'in', ['PENDING', 'REVIEWED'])
    .limit(300)
    .get();
  const items = (
    await filterBySite(
      session.ctx.tenantId,
      snap.docs.map((d) => d.data()) as { caseId: string; [k: string]: unknown }[],
      session.ctx.siteIds,
    )
  ).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return Response.json({
    pending: items.filter((i) => i.reviewStatus === 'PENDING'),
    reviewed: items.filter((i) => i.reviewStatus === 'REVIEWED').slice(0, 50),
    counts: {
      pending: items.filter((i) => i.reviewStatus === 'PENDING').length,
      reviewed: items.filter((i) => i.reviewStatus === 'REVIEWED').length,
    },
  });
});
