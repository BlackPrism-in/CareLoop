import type { EventEnvelope } from '@careloop/contracts';
import { caseEvents, verifyChain } from '@careloop/domain';
import { loadCase } from '@/server/case-helpers';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';

export const dynamic = 'force-dynamic';

/**
 * Checks a case's event history against its hash chain (owner, auditor).
 * Returns the head hash so it can be recorded outside CareLoop for a later check.
 */
export const GET = staffRoute<{ id: string }>(async ({ session, params }) => {
  if (!session.ctx.roles.some((r) => r === 'OWNER' || r === 'AUDITOR'))
    throw new HttpError('FORBIDDEN', 'Only owners and auditors can check integrity');
  const c = await loadCase(session.ctx.tenantId, params.id, session.ctx.siteIds);
  const snap = await firestore().collection(caseEvents(session.ctx.tenantId, c.caseId)).limit(2000).get();
  const result = verifyChain(snap.docs.map((d) => d.data() as EventEnvelope), c.lastEventHash);
  return Response.json({ caseId: c.caseId, version: c.version, headHash: c.lastEventHash ?? null, ...result });
});
