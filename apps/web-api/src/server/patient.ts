import 'server-only';
import { loadConfig } from '@careloop/contracts';
import { resolvePatientSession, type ActorContext, type PatientSessionDoc } from '@careloop/domain';
import { newCorrelationId } from '@careloop/observability';
import { HttpError, toErrorResponse } from './errors';
import { firestore } from './firebase';

export const PATIENT_COOKIE = 'cl_ps';

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = loadConfig().APP_ENV === 'local' ? '' : '; Secure';
  return `${PATIENT_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function readCookie(req: Request): string | undefined {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === PATIENT_COOKIE) return v.join('=');
  }
  return undefined;
}

/** Patient routes: no staff auth; an identity-gated session cookie bound to one case. */
export function patientRoute(
  fn: (a: {
    req: Request;
    session: PatientSessionDoc & { sessionHash: string };
    ctx: ActorContext;
  }) => Promise<Response>,
) {
  return async (req: Request) => {
    const correlationId = newCorrelationId();
    try {
      const session = await resolvePatientSession(firestore(), readCookie(req));
      if (!session)
        throw new HttpError('UNAUTHENTICATED', 'Your session has ended. Enter your code again.');
      const ctx: ActorContext = {
        tenantId: session.tenantId,
        actorType: 'PATIENT',
        actorId: `patient:${session.patientId}`,
        roles: [],
        correlationId,
      };
      const res = await fn({ req, session, ctx });
      res.headers.set('cache-control', 'no-store');
      return res;
    } catch (e) {
      return toErrorResponse(e, correlationId);
    }
  };
}
