import { randomUUID } from 'node:crypto';
import type { Case, Consent, Patient } from '@careloop/contracts';
import { sha256, tenantCollection, tenantRecord } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { ReasonOnlyBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';

/**
 * Patient erasure request (MVP spec §19 deletion workflow; DPDP review
 * pending). Refused while any obligation is open. Removes the patient's
 * identifiers and contact details, withdraws permission, revokes patient
 * links, and strips identifiers and excerpts from evidence. Case and event
 * metadata are kept under the customer's retention schedule; backups expire
 * on their own schedule. Audited.
 */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  if (!session.ctx.roles.includes('OWNER'))
    throw new HttpError('FORBIDDEN', 'Only an owner can erase patient data');
  const { reason } = ReasonOnlyBody.parse(await jsonBody(req));
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.id))
    throw new HttpError('NOT_FOUND', 'Patient not found');
  const t = session.ctx.tenantId;
  const db = firestore();
  const pRef = db.doc(tenantRecord(t, 'patients', params.id));
  const p = (await pRef.get()).data() as Patient | undefined;
  if (!p) throw new HttpError('NOT_FOUND', 'Patient not found');
  const cases = (
    await db.collection(tenantCollection(t, 'cases')).where('patientId', '==', p.patientId).get()
  ).docs.map((d) => d.data() as Case);
  const open = cases.filter((c) => !['COMPLETED_VERIFIED', 'CANCELLED'].includes(c.workflowState));
  if (open.length)
    throw new HttpError('DOMAIN_GUARD_FAILED', 'PATIENT_HAS_OPEN_CASES', {
      cases: open.map((c) => c.caseId).join(','),
    });

  const now = new Date().toISOString();
  const tag = `erased_${sha256(`${t}:${p.patientId}`).slice(0, 12)}`;
  const batch = db.batch();
  batch.set(pRef, {
    ...p,
    alias: 'Erased patient',
    contactMasked: '—',
    externalRef: tag,
    identityMethodRef: 'erased',
    erasedAt: now,
  } as Patient);
  for (const k of (
    await db.collection(tenantCollection(t, 'consents')).where('patientId', '==', p.patientId).get()
  ).docs) {
    const c = k.data() as Consent;
    if (!c.revokedAt)
      batch.update(k.ref, {
        revokedAt: now,
        version: c.version + 1,
        revokedBy: session.ctx.actorId,
        revokedReason: 'Patient data erased',
      });
  }
  for (const l of (
    await db
      .collection('patient_links')
      .where('tenantId', '==', t)
      .where('patientId', '==', p.patientId)
      .get()
  ).docs)
    batch.update(l.ref, { revokedAt: now });
  for (const c of cases) {
    for (const e of (
      await db.collection(tenantCollection(t, 'evidence')).where('caseId', '==', c.caseId).get()
    ).docs) {
      batch.update(e.ref, { patientRef: e.data().patientRef ? tag : null, excerpt: null });
    }
  }
  const auditId = randomUUID();
  batch.set(db.doc(tenantRecord(t, 'audit', auditId)), {
    auditId,
    action: 'PATIENT_ERASED',
    patientId: p.patientId,
    reason,
    actorId: session.ctx.actorId,
    at: now,
    correlationId: session.ctx.correlationId,
  });
  await batch.commit();
  return Response.json({ erased: true, patientId: p.patientId, casesKept: cases.length, auditId });
});
