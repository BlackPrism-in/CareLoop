import 'server-only';
import type { Member } from '@careloop/contracts';
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
  try {
    const decoded = await adminAuth().verifyIdToken(token, true);
    uid = decoded.uid;
    tenantId = decoded.tenantId;
  } catch {
    throw new HttpError('UNAUTHENTICATED', 'Session is invalid or expired');
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
