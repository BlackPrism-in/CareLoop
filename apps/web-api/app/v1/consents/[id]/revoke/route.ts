import { revokeConsent } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { RevokeConsentBody } from '@/server/schemas';
import { caseCommands } from '@/server/services';

export const dynamic = 'force-dynamic';

/** MVP-07: records withdrawal; suppression applies immediately to every open case using it. */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  if (!session.ctx.roles.some((r) => ['COORDINATOR', 'REVIEWER', 'OWNER'].includes(r)))
    throw new HttpError('FORBIDDEN', 'Not permitted');
  const { reason } = RevokeConsentBody.parse(await jsonBody(req));
  const r = await revokeConsent(firestore(), caseCommands(), session.ctx, {
    consentId: params.id,
    reason,
  });
  return Response.json(r);
});
