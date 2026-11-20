import 'server-only';
import { loadConfig, type Member } from '@careloop/contracts';
import type { ActorContext } from '@careloop/domain';
import { adminAuth } from './firebase';
import { HttpError } from './errors';
import { queries } from './services';

export interface StaffSession {
  ctx: ActorContext;
  member: Member;
}

/**
 * Bearer Firebase ID token → verified uid → tenant from a server-set custom
 * claim → membership document checked on EVERY request (so revocation or
 * suspension takes effect immediately). The client never supplies tenantId.
 */
export async function requireStaff(req: Request, correlationId: string): Promise<StaffSession> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError('UNAUTHENTICATED', 'Sign in required');

  let uid: string;
  let tenantId: unknown;
  let secondFactor: unknown;
  try {
    const decoded = await adminAuth().verifyIdToken(token, true);
    uid = decoded.uid;
    tenantId = decoded.tenantId;
    secondFactor = decoded.firebase?.sign_in_second_factor;
  } catch {
    throw new HttpError('UNAUTHENTICATED', 'Session is invalid or expired');
  }
  if (!hasRequiredFactor(loadConfig().REQUIRE_STAFF_MFA, secondFactor)) {
    // The UI turns this into "set up your authenticator app".
    throw new HttpError('FORBIDDEN', 'MFA_REQUIRED');
  }
  if (typeof tenantId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new HttpError('FORBIDDEN', 'Account is not a member of any lab');
  }
  const member = await queries().getMember(tenantId, uid);
  if (!member || member.status !== 'ACTIVE')
    throw new HttpError('FORBIDDEN', 'Membership is not active');

  return {
    member,
    ctx: { tenantId, actorType: 'STAFF', actorId: uid, roles: member.roleSet, correlationId },
  };
}

/** In the pilot every staff token must come from a second-factor sign-in (TOTP). */
export function hasRequiredFactor(required: boolean, signInSecondFactor: unknown): boolean {
  return !required || signInSecondFactor === 'totp' || signInSecondFactor === 'phone';
}
