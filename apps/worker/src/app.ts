import { Hono } from 'hono';
import type { JobRuntime } from '@careloop/jobs';
import { createLogger } from '@careloop/observability';

const log = createLogger('careloop-worker');

/** URL slug per outbox kind: /tasks/booking-request etc. */
export const TASK_KINDS = {
  'booking-request': 'BOOKING_REQUEST',
  'booking-reconcile': 'BOOKING_RECONCILE',
  'booking-cancel': 'BOOKING_CANCEL',
  'contact-attempt': 'CONTACT_ATTEMPT',
  'handoff-notify': 'HANDOFF_NOTIFY',
  'suppress-pending-work': 'SUPPRESS_PENDING_WORK',
} as const;

/**
 * Async worker (MVP spec §16). On Cloud Run only the Cloud Tasks / Scheduler
 * invoker identity may call it (IAM). Handlers return 2xx only after a durable
 * result or durable failure is stored; 409/503 ask the queue to retry.
 */
export function createApp(runtime: JobRuntime) {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok', service: 'careloop-worker' }));

  app.post('/tasks/recovery-sweep', async (c) => c.json(await runtime.dispatcher.sweep()));

  app.post('/tasks/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (!(kind in TASK_KINDS)) return c.json({ code: 'NOT_FOUND' }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      tenantId?: unknown;
      outboxId?: unknown;
    } | null;
    if (!body || typeof body.tenantId !== 'string' || typeof body.outboxId !== 'string') {
      return c.json({ code: 'VALIDATION_FAILED' }, 200); // malformed task: acknowledge, never retry
    }
    const r = await runtime.runner.run(body.tenantId, body.outboxId);
    log.info('task handled', {
      kind,
      outboxId: body.outboxId,
      status: r.status,
      duplicate: r.duplicate ?? false,
      taskName: c.req.header('x-cloudtasks-taskname'),
    });
    // A finished job may have enqueued follow-up work (e.g. reconcile after UNKNOWN).
    if (r.caseId) void runtime.dispatcher.dispatchCase(body.tenantId, r.caseId);
    return c.json(r, r.httpStatus);
  });
  return app;
}
