import WebSocket from 'ws';

/**
 * Post-deploy smoke test against a deployed environment (no data written).
 *   WEB_URL=https://… VOICE_URL=https://… pnpm --filter @careloop/scripts smoke
 * Optional signed-in checks: FIREBASE_WEB_API_KEY + SMOKE_STAFF_EMAIL + SMOKE_STAFF_PASSWORD
 * (a dedicated synthetic staff account in the staging project; supplied by CI secrets).
 */
const web = process.env.WEB_URL?.replace(/\/$/, '');
const voice = process.env.VOICE_URL?.replace(/\/$/, '');
if (!web || !voice) {
  console.error('Set WEB_URL and VOICE_URL');
  process.exit(2);
}

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${(e as Error).message}`);
  }
}
const expect = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

await check('web health', async () => {
  const r = await fetch(`${web}/api/health`);
  expect(r.status === 200, `status ${r.status}`);
});
await check('API refuses anonymous access with the error envelope', async () => {
  const r = await fetch(`${web}/v1/me`);
  const j = (await r.json()) as { code?: string; correlationId?: string };
  expect(r.status === 401 && j.code === 'UNAUTHENTICATED' && j.correlationId, `status ${r.status}`);
});
await check('webhooks reject unknown accounts', async () => {
  const r = await fetch(`${web}/webhooks/sandbox/smoke-unknown`, { method: 'POST', body: '{}' });
  expect(r.status === 404, `status ${r.status}`);
});
await check('patient API needs a session', async () => {
  const r = await fetch(`${web}/v1/p/me`);
  expect(r.status === 401, `status ${r.status}`);
});
await check('voice health', async () => {
  const r = await fetch(`${voice}/healthz`);
  expect(r.status === 200, `status ${r.status}`);
});
await check('voice refuses foreign origins', async () => {
  const code = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`${voice.replace(/^http/, 'ws')}/v1/voice/connect`, {
      origin: 'https://smoke.invalid',
    });
    ws.on('unexpected-response', (_q, res) => resolve(String(res.statusCode)));
    ws.on('open', () => resolve('opened'));
    ws.on('error', () => resolve('error'));
  });
  expect(code === '403', `got ${code}`);
});

const key = process.env.FIREBASE_WEB_API_KEY;
const email = process.env.SMOKE_STAFF_EMAIL;
const password = process.env.SMOKE_STAFF_PASSWORD;
if (key && email && password) {
  await check('synthetic staff account signs in and reads its lab', async () => {
    const s = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    const { idToken } = (await s.json()) as { idToken?: string };
    expect(idToken, 'sign-in failed');
    const me = await fetch(`${web}/v1/me`, { headers: { authorization: `Bearer ${idToken}` } });
    expect(me.status === 200, `me ${me.status}`);
    const cases = await fetch(`${web}/v1/cases?limit=1`, {
      headers: { authorization: `Bearer ${idToken}` },
    });
    expect(cases.status === 200, `cases ${cases.status}`);
  });
} else {
  console.log('skip  signed-in checks (no smoke staff credentials provided)');
}

process.exit(failed ? 1 : 0);
