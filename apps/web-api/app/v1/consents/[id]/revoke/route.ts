import { revokeConsent, tenantCollection } from '@careloop/domain';
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
  if (session.ctx.siteIds !== 'ALL' && session.ctx.siteIds !== undefined) {
    // Site-limited staff may only withdraw permission for patients they work with.
    const cases = await firestore().collection(tenantCollection(session.ctx.tenantId, 'cases')).where('consentId', '==', params.id).limit(50).get();
    const scope = session.ctx.siteIds;
    if (!cases.docs.some((d) => scope.includes(d.data().siteId as string))) throw new HttpError('NOT_FOUND', 'Consent not found');
  }
  const r = await revokeConsent(firestore(), caseCommands(), session.ctx, {
    consentId: params.id,
    reason,
  });
  return Response.json(r);
});
