import { GoogleAuth } from 'google-auth-library';
import type { Logger } from '@careloop/observability';

export interface TaskMessage {
  /** Deterministic task name: duplicates are rejected by the queue, not executed twice. */
  name: string;
  kind: string;
  tenantId: string;
  outboxId: string;
}

export interface TaskQueue {
  enqueue(m: TaskMessage): Promise<'CREATED' | 'ALREADY_EXISTS'>;
}

/** Collects tasks for tests; the test drives the runner. */
export class MemoryQueue implements TaskQueue {
  readonly tasks: TaskMessage[] = [];
  private readonly names = new Set<string>();
  async enqueue(m: TaskMessage) {
    if (this.names.has(m.name)) return 'ALREADY_EXISTS' as const;
    this.names.add(m.name);
    this.tasks.push(m);
    return 'CREATED' as const;
  }
  drain(): TaskMessage[] {
    return this.tasks.splice(0);
  }
}

/**
 * Local development stand-in for Cloud Tasks: POSTs to the worker with a few
 * retries, in-process. Not durable; the recovery sweep covers lost tasks.
 */
export class LocalHttpQueue implements TaskQueue {
  private readonly names = new Set<string>();
  constructor(
    private readonly workerUrl: string,
    private readonly log: Logger,
  ) {}

  async enqueue(m: TaskMessage) {
    if (this.names.has(m.name)) return 'ALREADY_EXISTS' as const;
    this.names.add(m.name);
    const deliver = async (attempt: number): Promise<void> => {
      try {
        const res = await fetch(
          `${this.workerUrl}/tasks/${m.kind.toLowerCase().replaceAll('_', '-')}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-cloudtasks-taskname': m.name,
              'x-cloudtasks-taskretrycount': String(attempt),
            },
            body: JSON.stringify({ tenantId: m.tenantId, outboxId: m.outboxId }),
          },
        );
        if (!res.ok && attempt < 3)
          setTimeout(() => void deliver(attempt + 1), 1000 * 2 ** attempt);
      } catch {
        if (attempt < 3) setTimeout(() => void deliver(attempt + 1), 1000 * 2 ** attempt);
        else this.log.warn('local task delivery failed', { task: m.name });
      }
    };
    setTimeout(() => void deliver(0), 0);
    return 'CREATED' as const;
  }
}

/**
 * Cloud Tasks via REST with an OIDC token for the worker (MVP spec §16, [T5]).
 * The worker's Cloud Run IAM only admits the invoker service account.
 */
export class CloudTasksQueue implements TaskQueue {
  private readonly auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  constructor(
    private readonly cfg: {
      project: string;
      location: string;
      queue: string;
      workerUrl: string;
      invokerEmail: string;
    },
  ) {}

  async enqueue(m: TaskMessage) {
    const parent = `projects/${this.cfg.project}/locations/${this.cfg.location}/queues/${this.cfg.queue}`;
    const url = `${this.cfg.workerUrl}/tasks/${m.kind.toLowerCase().replaceAll('_', '-')}`;
    const client = await this.auth.getClient();
    const res = await client.request({
      url: `https://cloudtasks.googleapis.com/v2/${parent}/tasks`,
      method: 'POST',
      validateStatus: () => true,
      data: {
        task: {
          name: `${parent}/tasks/${m.name}`,
          httpRequest: {
            url,
            httpMethod: 'POST',
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(
              JSON.stringify({ tenantId: m.tenantId, outboxId: m.outboxId }),
            ).toString('base64'),
            oidcToken: { serviceAccountEmail: this.cfg.invokerEmail, audience: this.cfg.workerUrl },
          },
        },
      },
    });
    if (res.status === 409) return 'ALREADY_EXISTS' as const;
    if (res.status >= 300) throw new Error(`Cloud Tasks create failed: ${res.status}`);
    return 'CREATED' as const;
  }
}
