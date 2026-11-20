import { openPatientSession, PATIENT_SESSION_TTL_MS } from '@careloop/domain';
import { newCorrelationId } from '@careloop/observability';
import { errorResponse, toErrorResponse } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody } from '@/server/handler';
import { sessionCookie } from '@/server/patient';
import { PatientSessionBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';

/** Identity gate: link token + one-time code → short session cookie. Five wrong codes lock the link. */
export async function POST(req: Request) {
  const correlationId = newCorrelationId();
  try {
    const { token, code } = PatientSessionBody.parse(await jsonBody(req));
    const r = await openPatientSession(firestore(), token, code.trim());
    if (!r.ok) {
      const message =
        r.reason === 'LOCKED'
          ? 'Too many attempts. Please call the lab.'
          : r.reason === 'EXPIRED'
            ? 'This link has expired. Please call the lab.'
            : 'That code did not match.';
      return errorResponse(
        r.reason === 'INVALID' ? 'UNAUTHENTICATED' : 'FORBIDDEN',
        message,
        correlationId,
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'set-cookie': sessionCookie(r.sessionToken, PATIENT_SESSION_TTL_MS / 1000),
      },
    });
  } catch (e) {
    return toErrorResponse(e, correlationId);
  }
}

export async function DELETE() {
  return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie('', 0) } });
}
