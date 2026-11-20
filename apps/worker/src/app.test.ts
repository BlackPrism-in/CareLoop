import { describe, expect, it } from 'vitest';
import { createApp } from './app';

describe('worker app', () => {
  it('reports health', async () => {
    const res = await createApp().request('/healthz');
    expect(res.status).toBe(200);
  });
  it('rejects unknown task kinds', async () => {
    const res = await createApp().request('/tasks/delete-everything', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
