import { serve } from '@hono/node-server';
import { createLogger } from '@careloop/observability';
import { createApp } from './app';

const port = Number(process.env.PORT ?? 8081);
serve({ fetch: createApp().fetch, port }, () =>
  createLogger('careloop-worker').info('listening', { port }),
);
