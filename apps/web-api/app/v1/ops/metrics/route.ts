import { tenantCollection, type HandoffDoc } from '@careloop/domain';
import type { OutboxDoc } from '@careloop/jobs';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';

export const dynamic = 'force-dynamic';

/**
 * Operations snapshot for the lab owner (MVP spec §20 dashboard): what is
 * stuck right now. Cloud Monitoring alerts cover the platform side.
 */
export const GET = staffRoute(async ({ session }) => {
  if (!session.ctx.roles.some((r) => r === 'OWNER' || r === 'AUDITOR'))
    throw new HttpError('FORBIDDEN', 'Not permitted');
  const db = firestore();
  const t = session.ctx.tenantId;
  const now = Date.now();
  const since24h = new Date(now - 86_400_000).toISOString();
  const [pending, failed, unknown, handoffs, interactions] = await Promise.all([
    db
      .collection(tenantCollection(t, 'outbox'))
      .where('status', 'in', ['PENDING', 'DISPATCHED'])
      .orderBy('createdAt')
      .limit(1)
      .get(),
    db.collection(tenantCollection(t, 'failed_jobs')).count().get(),
    db
      .collection(tenantCollection(t, 'cases'))
      .where('bookingState', '==', 'UNKNOWN')
      .count()
      .get(),
    db.collection(tenantCollection(t, 'handoffs')).where('status', '==', 'PENDING').get(),
    db
      .collection(tenantCollection(t, 'interactions'))
      .where('createdAt', '>=', since24h)
      .limit(500)
      .get(),
  ]);
  const oldest = pending.docs[0]?.data() as OutboxDoc | undefined;
  const hs = handoffs.docs.map((d) => d.data() as HandoffDoc);
  const calls = interactions.docs.map(
    (d) => d.data() as { status?: string; endReason?: string; unsupportedClaims?: number },
  );
  return Response.json({
    asOf: new Date(now).toISOString(),
    oldestPendingWorkSeconds: oldest ? Math.round((now - Date.parse(oldest.createdAt)) / 1000) : 0,
    failedJobs: failed.data().count,
    bookingsOutcomeUnknown: unknown.data().count,
    handoffsWaiting: hs.length,
    handoffsOverdue: hs.filter((h) => Date.parse(h.dueAt) < now).length,
    calls24h: {
      total: calls.length,
      failedToConnect: calls.filter((c) => c.status === 'FAILED_TO_CONNECT').length,
      disconnected: calls.filter(
        (c) =>
          c.endReason === 'CLIENT_DISCONNECTED' ||
          c.endReason === 'MODEL_ERROR' ||
          c.endReason === 'MODEL_CLOSED',
      ).length,
      flaggedClaims: calls.reduce((n, c) => n + (c.unsupportedClaims ?? 0), 0),
    },
  });
});
