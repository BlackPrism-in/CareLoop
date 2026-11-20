import { HttpError } from '@/server/errors';
import { staffRoute } from '@/server/handler';
import { jobQueries, queries } from '@/server/services';
import { firestore } from '@/server/firebase';
import {
  tenantCollection,
  tenantRecord,
  type EvidenceDoc,
  type HandoffDoc,
} from '@careloop/domain';

export const dynamic = 'force-dynamic';

export const GET = staffRoute<{ id: string }>(async ({ session, params }) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.id)) throw new HttpError('NOT_FOUND', 'Case not found');
  const detail = await queries().caseDetail(session.ctx.tenantId, params.id);
  // Cross-tenant ids are indistinguishable from missing ones.
  if (!detail) throw new HttpError('NOT_FOUND', 'Case not found');
  const t = session.ctx.tenantId;
  const db = firestore();
  const [bookings, evidence, handoff] = await Promise.all([
    jobQueries().bookingsForCase(t, params.id),
    db
      .collection(tenantCollection(t, 'evidence'))
      .where('caseId', '==', params.id)
      .orderBy('receivedAt', 'desc')
      .limit(20)
      .get(),
    detail.case.activeHandoffId
      ? db.doc(tenantRecord(t, 'handoffs', detail.case.activeHandoffId)).get()
      : null,
  ]);
  return Response.json({
    ...detail,
    bookings,
    evidence: evidence.docs.map((d) => d.data() as EvidenceDoc),
    handoff: handoff?.exists ? (handoff.data() as HandoffDoc) : null,
  });
});
