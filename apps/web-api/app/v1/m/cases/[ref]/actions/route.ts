import { DomainError, revokeConsent } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { jsonBody } from '@/server/handler';
import { caseSummary, loadPatientCase, mobileRoute, patientCtx } from '@/server/mobile';
import { PatientActionBody } from '@/server/schemas';
import { caseCommands, kick } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * Ask for a different time or a call (a staff task; an existing appointment is
 * NOT cancelled), or stop automated contact (consent withdrawn at once).
 */
export const POST = mobileRoute<{ ref: string }>(
  async ({ req, params, session, correlationId }) => {
    const { action } = PatientActionBody.parse(await jsonBody(req));
    const { tenantId, c } = await loadPatientCase(session, params.ref);
    const ctx = patientCtx(tenantId, c.patientId, correlationId);
    if (action === 'STOP_CONTACT') {
      await revokeConsent(firestore(), caseCommands(), ctx, {
        consentId: c.consentId,
        reason: 'Patient stopped automated contact in the app',
      });
    } else {
      try {
        await caseCommands().createHandoff(ctx, {
          caseId: c.caseId,
          expectedVersion: c.version,
          idempotencyKey: `app:${session.sessionHash.slice(0, 16)}:${c.caseId}:${action}`,
          input: {
            reasonCode:
              action === 'REQUEST_CHANGE' ? 'PATIENT_REQUESTED_CHANGE' : 'CALLBACK_REQUESTED',
            ownerId: c.ownerId,
            dueAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
          },
        });
      } catch (e) {
        if (!(e instanceof DomainError && e.reason === 'HANDOFF_ALREADY_OPEN')) throw e;
      }
    }
    await kick(tenantId, c.caseId);
    const fresh = await loadPatientCase(session, params.ref);
    return Response.json(await caseSummary(tenantId, fresh.c));
  },
);
