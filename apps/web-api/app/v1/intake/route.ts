import { loadConfig } from '@careloop/contracts';
import { createGenAIClient, GenAiJsonModel, ModelError, runIntake } from '@careloop/ai';
import { HttpError } from '@/server/errors';
import { jsonBody, staffRoute } from '@/server/handler';
import { IntakeBody } from '@/server/schemas';
import { createLogger } from '@careloop/observability';

export const dynamic = 'force-dynamic';
const log = createLogger('careloop-web-api');

/**
 * Intake agent (P1): approved instruction text → proposed administrative
 * fields with source spans. Nothing is stored; staff review the proposal in
 * the New follow-up form, and a reviewer still approves the case.
 */
export const POST = staffRoute(async ({ req, session }) => {
  if (!session.ctx.roles.some((r) => r === 'COORDINATOR' || r === 'REVIEWER'))
    throw new HttpError('FORBIDDEN', 'Not permitted');
  const { text } = IntakeBody.parse(await jsonBody(req));
  const cfg = loadConfig();
  try {
    const result = await runIntake(
      new GenAiJsonModel(createGenAIClient(cfg)),
      cfg.INTAKE_MODEL_ID,
      text,
    );
    log.info('intake extracted', {
      correlationId: session.ctx.correlationId,
      fields: Object.keys(result.fields).length,
      rejected: result.rejected.length,
      promptVersion: result.promptVersion,
    });
    return Response.json(result);
  } catch (e) {
    const reason = e instanceof ModelError ? e.reason : 'PROVIDER_ERROR';
    log.warn('intake model unavailable', { correlationId: session.ctx.correlationId, reason });
    throw new HttpError('THROTTLED', 'MODEL_UNAVAILABLE', { reason });
  }
});
