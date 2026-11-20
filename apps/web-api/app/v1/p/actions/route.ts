import type { Case } from '@careloop/contracts';
import { DomainError, revokeConsent, tenantRecord } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { jsonBody } from '@/server/handler';
import { patientRoute } from '@/server/patient';
import { PatientActionBody } from '@/server/schemas';
import { caseCommands, kick } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * Patient actions (MVP spec §07): asking for a change or a call creates a
 * staff task and does NOT cancel an existing appointment. Stopping automated
 * contact withdraws consent immediately.
 */
export const POST = patientRoute(async ({ req, session, ctx }) => {
  const { action } = PatientActionBody.parse(await jsonBody(req));
  const db = firestore();
  const c = (
    await db.doc(tenantRecord(session.tenantId, 'cases', session.caseId)).get()
  ).data() as Case;
  const key = `patient:${session.sessionHash}:${action}`;
  if (action === 'STOP_CONTACT') {
    await revokeConsent(db, caseCommands(), ctx, {
      consentId: c.consentId,
      reason: 'Patient stopped automated contact from their link',
    });
  } else {
    try {
      await caseCommands().createHandoff(ctx, {
        caseId: c.caseId,
        expectedVersion: c.version,
        idempotencyKey: key,
        input: {
          reasonCode:
            action === 'REQUEST_CHANGE' ? 'PATIENT_REQUESTED_CHANGE' : 'CALLBACK_REQUESTED',
          ownerId: c.ownerId,
          dueAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        },
      });
    } catch (e) {
      // A staff task is already open: the lab will call either way.
      if (!(e instanceof DomainError && e.reason === 'HANDOFF_ALREADY_OPEN')) throw e;
    }
  }
  await kick(session.tenantId, c.caseId);
  return Response.json({ ok: true, action });
});
