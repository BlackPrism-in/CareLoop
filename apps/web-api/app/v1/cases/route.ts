import { sha256 } from '@careloop/domain';
import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { CreateCaseBody, ListCasesQuery } from '@/server/schemas';
import { caseCommands, queries } from '@/server/services';

export const dynamic = 'force-dynamic';

export const GET = staffRoute(async ({ req, session }) => {
  const q = ListCasesQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
  const page = await queries().listCases(session.ctx.tenantId, {
    siteIds: session.ctx.siteIds,
    workflowState: q.workflowState,
    ownerId: q.owner === 'me' ? session.ctx.actorId : undefined,
    handoffPending: q.view === 'handoffs',
    needsProofReview: q.view === 'proof',
    cursor: q.cursor,
    limit: q.limit,
  });
  return Response.json(page);
});

/** MVP-01: creates a DRAFT. Returns 201 for a new case, 200 + warning for a duplicate. */
export const POST = staffRoute(async ({ req, session }) => {
  const key = idempotencyKey(req);
  const body = CreateCaseBody.parse(await jsonBody(req));
  const sourceId = await queries().ensureSource(session.ctx.tenantId, body.source);
  const { source: _source, caseId, ...rest } = body;
  const result = await caseCommands().createCase(session.ctx, {
    idempotencyKey: key,
    // Derived from the idempotency key so a retried request maps to the same case id.
    input: {
      ...rest,
      sourceId,
      caseId: caseId ?? `CL-${sha256(`${session.ctx.actorId}:${key}`).slice(0, 8).toUpperCase()}`,
    },
  });
  const created = result.eventType === 'CASE_CREATED' && !result.replayed;
  return Response.json(result, { status: created ? 201 : 200 });
});
