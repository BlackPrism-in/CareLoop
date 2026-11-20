import { randomUUID } from 'node:crypto';
import { caseEvents, tenantCollection, tenantRecord } from '@careloop/domain';
import { loadCase } from '@/server/case-helpers';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';

export const dynamic = 'force-dynamic';

/**
 * Role-restricted case export with access history (MVP spec §19). Contains the
 * case, its event history, evidence, handoffs, bookings and call summaries.
 * No transcripts or audio exist to export.
 */
export const GET = staffRoute<{ id: string }>(async ({ session, params }) => {
  if (!session.ctx.roles.some((r) => r === 'OWNER' || r === 'AUDITOR'))
    throw new HttpError('FORBIDDEN', 'Only owners and auditors can export');
  const t = session.ctx.tenantId;
  const c = await loadCase(t, params.id);
  const db = firestore();
  const byCase = (col: Parameters<typeof tenantCollection>[1]) =>
    db.collection(tenantCollection(t, col)).where('caseId', '==', c.caseId).get();
  const [events, evidence, handoffs, bookings, interactions] = await Promise.all([
    db.collection(caseEvents(t, c.caseId)).orderBy('nextVersion').get(),
    byCase('evidence'),
    byCase('handoffs'),
    byCase('bookings'),
    byCase('interactions'),
  ]);
  const at = new Date().toISOString();
  const auditId = randomUUID();
  await db.doc(tenantRecord(t, 'audit', auditId)).set({
    auditId,
    action: 'CASE_EXPORTED',
    caseId: c.caseId,
    actorId: session.ctx.actorId,
    at,
    correlationId: session.ctx.correlationId,
  });
  const body = {
    exportedAt: at,
    exportedBy: session.ctx.actorId,
    auditId,
    case: c,
    events: events.docs.map((d) => d.data()),
    evidence: evidence.docs.map((d) => d.data()),
    handoffs: handoffs.docs.map((d) => d.data()),
    bookings: bookings.docs.map((d) => d.data()),
    interactions: interactions.docs.map((d) => d.data()),
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${c.caseId}-export.json"`,
    },
  });
});
