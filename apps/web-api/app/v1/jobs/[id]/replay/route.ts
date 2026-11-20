import { HttpError } from '@/server/errors';
import { staffRoute } from '@/server/handler';
import { jobQueries, jobRuntime, kick } from '@/server/services';
import { createLogger } from '@careloop/observability';

export const dynamic = 'force-dynamic';
const log = createLogger('careloop-web-api');

/** Owner-only replay. Keeps the original operation id so provider idempotency still applies. */
export const POST = staffRoute<{ id: string }>(async ({ session, params }) => {
  if (!session.ctx.roles.includes('OWNER'))
    throw new HttpError('FORBIDDEN', 'Only an owner can replay jobs');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(params.id)) throw new HttpError('NOT_FOUND', 'Job not found');
  const failed = (await jobQueries().failedJobs(session.ctx.tenantId)).find(
    (j) => j.jobId === params.id,
  );
  if (!failed) throw new HttpError('NOT_FOUND', 'Job not found');
  const ok = await jobRuntime().runner.replay(session.ctx.tenantId, params.id, session.ctx.actorId);
  if (!ok) throw new HttpError('NOT_FOUND', 'Job not found');
  log.info('job replayed', {
    jobId: params.id,
    by: session.ctx.actorId,
    correlationId: session.ctx.correlationId,
  });
  await kick(session.ctx.tenantId, failed.caseId);
  return Response.json({ replayed: true, jobId: params.id }, { status: 202 });
});
