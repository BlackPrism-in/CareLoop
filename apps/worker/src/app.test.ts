import { describe, expect, it, vi } from 'vitest';
import type { JobRuntime } from '@careloop/jobs';
import { createApp } from './app';

function fakeRuntime() {
  const run = vi.fn(async () => ({ httpStatus: 200 as const, status: 'DONE' as const }));
  const sweep = vi.fn(async () => ({ dispatched: 0, redelivered: 0, settled: 0 }));
  return {
    runtime: { runner: { run }, dispatcher: { sweep } } as unknown as JobRuntime,
    run,
    sweep,
  };
}

describe('worker app', () => {
  it('reports health', async () => {
    expect((await createApp(fakeRuntime().runtime).request('/healthz')).status).toBe(200);
  });
  it('rejects unknown task kinds', async () => {
    const res = await createApp(fakeRuntime().runtime).request('/tasks/delete-everything', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
  it('acknowledges malformed tasks without running anything', async () => {
    const f = fakeRuntime();
    const res = await createApp(f.runtime).request('/tasks/booking-request', {
      method: 'POST',
      body: '{"x":1}',
    });
    expect(res.status).toBe(200);
    expect(f.run).not.toHaveBeenCalled();
  });
  it('passes the runner status through so the queue retries 503s', async () => {
    const f = fakeRuntime();
    f.run.mockResolvedValueOnce({ httpStatus: 503, status: 'RETRY' } as never);
    const res = await createApp(f.runtime).request('/tasks/booking-request', {
      method: 'POST',
      body: JSON.stringify({ tenantId: 't', outboxId: 'o' }),
    });
    expect(res.status).toBe(503);
    expect(f.run).toHaveBeenCalledWith('t', 'o');
  });
});
