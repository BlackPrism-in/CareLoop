import type { Case, Patient } from '@careloop/contracts';
import { tenantCollection, tenantRecord } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { caseSummary, mobileRoute } from '@/server/mobile';

export const dynamic = 'force-dynamic';

/** The signed-in patient's follow-ups across the labs that recorded this number. */
export const GET = mobileRoute(async ({ session }) => {
  const db = firestore();
  const followUps = [];
  let language: string | null = null;
  for (const p of session.patients) {
    const [patient, cases] = await Promise.all([
      db.doc(tenantRecord(p.tenantId, 'patients', p.patientId)).get(),
      db
        .collection(tenantCollection(p.tenantId, 'cases'))
        .where('patientId', '==', p.patientId)
        .get(),
    ]);
    language ??= (patient.data() as Patient | undefined)?.language ?? null;
    for (const d of cases.docs) {
      const c = d.data() as Case;
      if (c.workflowState === 'DRAFT') continue; // not approved yet: nothing to show
      followUps.push(await caseSummary(p.tenantId, c));
    }
  }
  followUps.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return Response.json({ language: language ?? 'en-IN', followUps });
});
