import type { Case, Consent, Site, Tenant } from '@careloop/contracts';
import { tenantDoc, tenantRecord } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { patientRoute } from '@/server/patient';
import { jobQueries } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * What the patient may see (MVP spec §07): lab, kind of follow-up, appointment
 * or request status, and whether automated contact is on. No name, no report,
 * no staff notes, no other cases.
 */
export const GET = patientRoute(async ({ session }) => {
  const db = firestore();
  const t = session.tenantId;
  const [tenant, c] = await Promise.all([
    db.doc(tenantDoc(t)).get(),
    db.doc(tenantRecord(t, 'cases', session.caseId)).get(),
  ]);
  const cs = c.data() as Case;
  const [site, consent, bookings] = await Promise.all([
    db.doc(tenantRecord(t, 'sites', cs.siteId)).get(),
    db.doc(tenantRecord(t, 'consents', cs.consentId)).get(),
    jobQueries().bookingsForCase(t, cs.caseId),
  ]);
  const b = bookings.find((x) =>
    ['CONFIRMED', 'REQUESTED', 'PENDING_STAFF', 'UNKNOWN', 'CANCEL_PENDING'].includes(x.status),
  );
  const k = consent.data() as Consent | undefined;
  const status =
    cs.workflowState === 'COMPLETED_VERIFIED'
      ? 'DONE'
      : cs.workflowState === 'CANCELLED'
        ? 'CLOSED'
        : b?.status === 'CONFIRMED'
          ? 'BOOKED'
          : b
            ? 'REQUEST_RECEIVED'
            : 'NOT_BOOKED';
  return Response.json({
    labName: (tenant.data() as Tenant).displayName,
    siteName: (site.data() as Site | undefined)?.displayName ?? null,
    timeZone: (site.data() as Site | undefined)?.timeZone ?? 'Asia/Kolkata',
    followUp: cs.actionType === 'ORDERED_TEST' ? 'ORDERED_TEST' : 'CONSULTATION',
    dueAt: cs.dueAt,
    status,
    appointment:
      b && b.status === 'CONFIRMED' ? { startsAt: b.startsAt, location: b.location } : null,
    labWillCall: cs.handoffState === 'PENDING' || cs.handoffState === 'ACKNOWLEDGED',
    automatedContact: !!k && !k.revokedAt && cs.outreachDisposition !== 'OPTED_OUT',
    language: cs.language,
    simulation: (tenant.data() as Tenant).simulation,
  });
});
