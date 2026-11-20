import 'server-only';
import { newCorrelationId } from '@careloop/observability';
import { requireStaff, type StaffSession } from './auth';
import { HttpError, toErrorResponse } from './errors';

type Params = Record<string, string>;

/**
 * Wraps a staff route: correlation id, authentication + membership, error
 * envelope. Responses are never cached (they contain tenant data).
 */
export function staffRoute<P extends Params = Params>(
  fn: (args: {
    req: Request;
    session: StaffSession;
    params: P;
    correlationId: string;
  }) => Promise<Response>,
) {
  return async (req: Request, ctx: { params: Promise<P> }) => {
    const correlationId = newCorrelationId();
    try {
      const session = await requireStaff(req, correlationId);
      const res = await fn({ req, session, params: await ctx.params, correlationId });
      res.headers.set('cache-control', 'no-store');
      res.headers.set('x-correlation-id', correlationId);
      return res;
    } catch (e) {
      const res = toErrorResponse(e, correlationId);
      res.headers.set('x-correlation-id', correlationId);
      return res;
    }
  };
}

export function idempotencyKey(req: Request): string {
  const key = req.headers.get('idempotency-key')?.trim();
  if (!key || key.length > 200)
    throw new HttpError('VALIDATION_FAILED', 'Idempotency-Key header is required');
  return key;
}

export async function jsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 64_000) throw new HttpError('VALIDATION_FAILED', 'Body too large');
  return text ? JSON.parse(text) : {};
}
