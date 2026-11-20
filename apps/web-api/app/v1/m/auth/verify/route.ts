import { normalisePhone, verifyPhoneLogin } from '@careloop/domain';
import { newCorrelationId } from '@careloop/observability';
import { errorResponse, toErrorResponse } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody } from '@/server/handler';
import { MobileVerifyBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';

/** Step 2: number + code → a 7-day app session (bearer token). Five wrong codes lock the code. */
export async function POST(req: Request) {
  const correlationId = newCorrelationId();
  try {
    const { phone, code } = MobileVerifyBody.parse(await jsonBody(req));
    const e164 = normalisePhone(phone);
    const r = e164 ? await verifyPhoneLogin(firestore(), e164, code.trim()) : null;
    if (!r?.ok) {
      const reason = r?.reason ?? 'INVALID';
      return errorResponse(
        reason === 'INVALID' ? 'UNAUTHENTICATED' : 'FORBIDDEN',
        reason === 'LOCKED'
          ? 'Too many attempts. Ask for a new code.'
          : reason === 'EXPIRED'
            ? 'That code has expired. Ask for a new one.'
            : 'That code did not match.',
        correlationId,
      );
    }
    return Response.json(
      { token: r.sessionToken, expiresAt: r.expiresAt },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return toErrorResponse(e, correlationId);
  }
}
