import { loadEvidence } from '@/server/case-helpers';
import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { AttestBody } from '@/server/schemas';
import { caseCommands } from '@/server/services';

export const dynamic = 'force-dynamic';

/** MVP-09: a named verifier verifies (with cited source and reason) or rejects a candidate. */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  const key = idempotencyKey(req);
  const body = AttestBody.parse(await jsonBody(req));
  const ev = await loadEvidence(session.ctx.tenantId, params.id);
  const result = await caseCommands().attestEvidence(session.ctx, {
    caseId: ev.caseId,
    expectedVersion: body.expectedVersion,
    idempotencyKey: key,
    input: {
      evidenceId: ev.evidenceId,
      decision: body.decision,
      reason: body.reason,
      sourceRef: body.sourceRef,
    },
  });
  return Response.json(result);
});
