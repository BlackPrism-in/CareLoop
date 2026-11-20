import { endMobileSession } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { bearer } from '@/server/mobile';

export const dynamic = 'force-dynamic';

/** Sign out: the session token stops working at once. */
export async function DELETE(req: Request) {
  await endMobileSession(firestore(), bearer(req));
  return new Response(null, { status: 204 });
}
