import { errorResponse } from '@/http';

export const dynamic = 'force-dynamic';

/** Phase 2 replaces this with Firebase ID-token verification + membership lookup. */
export function GET() {
  return errorResponse('UNAUTHENTICATED', 'Staff authentication is not configured yet.');
}
