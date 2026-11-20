import { serve } from '@hono/node-server';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { loadConfig } from '@careloop/contracts';
import { createJobRuntime } from '@careloop/jobs';
import { createLogger } from '@careloop/observability';
import { createApp } from './app';

const log = createLogger('careloop-worker');
const cfg = loadConfig();
const app = getApps()[0] ?? initializeApp({ projectId: cfg.GOOGLE_CLOUD_PROJECT });
const runtime = createJobRuntime(cfg, getFirestore(app), log);

const port = Number(process.env.PORT ?? 8081);
serve({ fetch: createApp(runtime).fetch, port }, () =>
  log.info('listening', { port, queue: cfg.TASK_QUEUE_MODE, booking: cfg.BOOKING_ADAPTER }),
);

// Locally there is no Cloud Scheduler: sweep in-process so lost work is recovered.
if (cfg.APP_ENV === 'local') {
  setInterval(
    () =>
      void Promise.all([runtime.dispatcher.sweep(), runtime.sweeps.run()]).catch((e) =>
        log.warn('sweep failed', { error: (e as Error).message }),
      ),
    10_000,
  );
}
