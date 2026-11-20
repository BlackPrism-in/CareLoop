import { Hono } from 'hono';
import { createLogger } from '@careloop/observability';

const log = createLogger('careloop-worker');

/**
 * Async worker (MVP spec §16). Cloud Tasks invokes /tasks/:kind with an OIDC
 * token from a dedicated service account; Cloud Run IAM rejects anything else.
 * Handlers must return 2xx only after a durable result or durable failure is
 * stored. Phase 3 implements the outbox dispatcher, recovery sweep and jobs.
 */
export const TASK_KINDS = [
  'dispatch-outbox',
  'recovery-sweep',
  'intake',
  'verification',
  'booking',
  'contact',
] as const;

export function createApp() {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok', service: 'careloop-worker' }));
  app.post('/tasks/:kind', (c) => {
    const kind = c.req.param('kind');
    if (!(TASK_KINDS as readonly string[]).includes(kind))
      return c.json({ code: 'NOT_FOUND' }, 404);
    log.warn('task handler not implemented', {
      kind,
      taskName: c.req.header('x-cloudtasks-taskname'),
    });
    // 501 is not retried as success; Phase 3 replaces with durable handlers.
    return c.json({ code: 'NOT_IMPLEMENTED', kind }, 501);
  });
  return app;
}
