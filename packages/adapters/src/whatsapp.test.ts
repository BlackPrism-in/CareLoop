import { describe, expect, it, vi } from 'vitest';
import { maskPhone, WhatsAppSender } from './whatsapp';

const base = {
  mode: 'whatsapp' as const,
  appEnv: 'demo',
  phoneNumberId: '123456789',
  accessToken: 'test-token-not-real-000000',
  graphVersion: 'v23.0',
  testRecipients: ['+919800000001'],
};
const ok = () =>
  vi.fn(
    async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }),
  );

describe('WhatsAppSender', () => {
  it('outside the pilot sends only to allow-listed test phones', async () => {
    const f = ok();
    const s = new WhatsAppSender(base, f as unknown as typeof fetch);
    const msg = {
      template: 'BOOKING_CONFIRMED' as const,
      language: 'en-IN' as const,
      params: ['a', 'b', 'c', 'd'],
    };
    expect(await s.send({ ...msg, to: '+919800000002' })).toMatchObject({
      status: 'SIMULATED',
      reason: 'NOT_A_TEST_RECIPIENT',
    });
    expect(f).not.toHaveBeenCalled();
    expect(await s.send({ ...msg, to: '+919800000001' })).toMatchObject({
      status: 'SENT',
      providerRef: 'wamid.1',
    });
    expect(f).toHaveBeenCalledOnce();
  });

  it('simulated mode never calls Meta', async () => {
    const f = ok();
    const s = new WhatsAppSender({ ...base, mode: 'simulated' }, f as unknown as typeof fetch);
    const r = await s.send({
      to: '+919800000001',
      template: 'LOGIN_CODE',
      language: 'hi-IN',
      params: ['123456'],
    });
    expect(r.status).toBe('SIMULATED');
    expect(f).not.toHaveBeenCalled();
  });

  it('login codes go in the body and the copy-code button, in the patient language', async () => {
    const f = ok();
    await new WhatsAppSender(base, f as unknown as typeof fetch).send({
      to: '+919800000001',
      template: 'LOGIN_CODE',
      language: 'hi-IN',
      params: ['123456'],
    });
    const body = JSON.parse(
      (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.to).toBe('919800000001');
    expect(body.template.name).toBe('careloop_login_code');
    expect(body.template.language.code).toBe('hi');
    expect(body.template.components).toHaveLength(2);
  });

  it('reports Meta errors without the message content', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 132001, message: 'Template does not exist' } }),
          { status: 404 },
        ),
    );
    const r = await new WhatsAppSender(base, f as unknown as typeof fetch).send({
      to: '+919800000001',
      template: 'VISIT_REMINDER',
      language: 'en-IN',
      params: ['a', 'b', 'c', 'd'],
    });
    expect(r).toMatchObject({ status: 'FAILED' });
    expect(r.reason).toContain('132001');
  });

  it('falls back to an approved login template while ours is in review', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 132001, message: 'Template not approved' } }),
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.2' }] }), { status: 200 }),
      );
    const r = await new WhatsAppSender(
      { ...base, loginFallbackTemplate: 'login_code' },
      f as unknown as typeof fetch,
    ).send({
      to: '+919800000001',
      template: 'LOGIN_CODE',
      language: 'hi-IN',
      params: ['123456'],
    });
    expect(r).toMatchObject({ status: 'SENT', providerRef: 'wamid.2' });
    const second = JSON.parse(
      (f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(second.template).toMatchObject({ name: 'login_code', language: { code: 'en' } });
  });

  it('masks numbers for display', () => expect(maskPhone('+919800000101')).toBe('+91 •••••• 0101'));
});
