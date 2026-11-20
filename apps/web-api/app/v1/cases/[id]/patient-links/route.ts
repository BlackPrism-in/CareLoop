import { loadConfig } from '@careloop/contracts';
import { automatedContactAllowed, createPatientLink } from '@careloop/domain';
import { loadCase } from '@/server/case-helpers';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';
import { queries } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * Creates a patient action link and a separate one-time code. Both are shown
 * once. Sending them needs an approved messaging channel; in a synthetic lab
 * nothing is sent and the response says so.
 */
export const POST = staffRoute<{ id: string }>(async ({ session, params }) => {
  if (!session.ctx.roles.includes('COORDINATOR'))
    throw new HttpError('FORBIDDEN', 'Only coordinators can create patient links');
  const c = await loadCase(session.ctx.tenantId, params.id, session.ctx.siteIds);
  if (['DRAFT', 'CANCELLED', 'COMPLETED_VERIFIED'].includes(c.workflowState))
    throw new HttpError('DOMAIN_GUARD_FAILED', 'CASE_NOT_OPEN_FOR_PATIENT');
  // Patient links are CareLoop outreach: baseline and usual-care cases follow the lab's normal process.
  if (!automatedContactAllowed(c.pilotArm))
    throw new HttpError('DOMAIN_GUARD_FAILED', 'NOT_IN_INTERVENTION_ARM');
  const tenant = (await queries().lookups(session.ctx.tenantId, session.ctx.siteIds)).tenant;
  const { token, code, expiresAt } = await createPatientLink(firestore(), {
    tenantId: session.ctx.tenantId,
    caseId: c.caseId,
    patientId: c.patientId,
    createdBy: session.ctx.actorId,
  });
  return Response.json(
    {
      url: `${loadConfig().PATIENT_LINK_BASE_URL}/p/${token}`,
      code,
      expiresAt,
      delivery: tenant?.simulation ? 'SIMULATED_NOT_SENT' : 'MANUAL',
    },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
});
