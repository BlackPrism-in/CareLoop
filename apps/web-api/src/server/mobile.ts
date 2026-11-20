import 'server-only';
import type { Case, Consent, Site, Tenant } from '@careloop/contracts';
import {
  resolveMobileSession,
  tenantDoc,
  tenantRecord,
  type ActorContext,
  type PatientRef,
} from '@careloop/domain';
import { newCorrelationId } from '@careloop/observability';
import { HttpError, toErrorResponse } from './errors';
import { firestore } from './firebase';
import { jobQueries } from './services';

type Params = Record<string, string>;

export function bearer(req: Request): string | undefined {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/**
 * Patient-app routes: a bearer session from WhatsApp-code sign-in. The patient
 * sees only cases of the patient records their number belongs to.
 */
export function mobileRoute<P extends Params = Params>(
  fn: (a: {
    req: Request;
    params: P;
    session: { sessionHash: string; patients: PatientRef[] };
    correlationId: string;
  }) => Promise<Response>,
) {
  return async (req: Request, ctx: { params: Promise<P> }) => {
    const correlationId = newCorrelationId();
    try {
      const session = await resolveMobileSession(firestore(), bearer(req));
      if (!session) throw new HttpError('UNAUTHENTICATED', 'Please sign in again.');
      const res = await fn({ req, params: await ctx.params, session, correlationId });
      res.headers.set('cache-control', 'no-store');
      return res;
    } catch (e) {
      return toErrorResponse(e, correlationId);
    }
  };
}

/** "t_demo_siliguri.CL-2001" → the case, if it belongs to one of this session's patients. */
export async function loadPatientCase(
  session: { patients: PatientRef[] },
  ref: string,
): Promise<{ tenantId: string; c: Case }> {
  const m = /^([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{1,128})$/.exec(ref);
  if (!m) throw new HttpError('NOT_FOUND', 'Not found');
  const [, tenantId, caseId] = m as unknown as [string, string, string];
  const snap = await firestore()
    .doc(tenantRecord(tenantId, 'cases', caseId))
    .get();
  const c = snap.data() as Case | undefined;
  if (
    !c ||
    c.workflowState === 'DRAFT' ||
    !session.patients.some((p) => p.tenantId === tenantId && p.patientId === c.patientId)
  )
    throw new HttpError('NOT_FOUND', 'Not found');
  return { tenantId, c };
}

export function patientCtx(
  tenantId: string,
  patientId: string,
  correlationId: string,
): ActorContext {
  return {
    tenantId,
    actorType: 'PATIENT',
    actorId: `patient:${patientId}`,
    roles: [],
    correlationId,
  };
}

const ACTIVE_BOOKING = ['CONFIRMED', 'REQUESTED', 'PENDING_STAFF', 'UNKNOWN', 'CANCEL_PENDING'];

/** What the patient may see (MVP spec §07): no names, reports or staff notes. */
export async function caseSummary(tenantId: string, c: Case) {
  const db = firestore();
  const [tenant, site, consent, bookings] = await Promise.all([
    db.doc(tenantDoc(tenantId)).get(),
    db.doc(tenantRecord(tenantId, 'sites', c.siteId)).get(),
    db.doc(tenantRecord(tenantId, 'consents', c.consentId)).get(),
    jobQueries().bookingsForCase(tenantId, c.caseId),
  ]);
  const b = bookings.find((x) => ACTIVE_BOOKING.includes(x.status));
  const k = consent.data() as Consent | undefined;
  const t = tenant.data() as Tenant;
  const s = site.data() as Site | undefined;
  // The booking record is written by the worker; until then the case's own state counts.
  const confirmed = b?.status === 'CONFIRMED' || c.bookingState === 'CONFIRMED';
  const pending = !!b || c.bookingState === 'REQUESTED' || c.bookingState === 'UNKNOWN';
  const status =
    c.workflowState === 'COMPLETED_VERIFIED'
      ? 'DONE'
      : c.workflowState === 'CANCELLED'
        ? 'CLOSED'
        : confirmed
          ? 'BOOKED'
          : pending
            ? 'REQUEST_RECEIVED'
            : 'NOT_BOOKED';
  const automatedContact = !!k && !k.revokedAt && c.outreachDisposition !== 'OPTED_OUT';
  return {
    ref: `${tenantId}.${c.caseId}`,
    labName: t.displayName,
    siteName: s?.displayName ?? null,
    timeZone: s?.timeZone ?? t.timeZone,
    followUp: c.actionType,
    dueAt: c.dueAt,
    status,
    appointment:
      b?.status === 'CONFIRMED'
        ? { startsAt: b.startsAt, location: b.location }
        : confirmed && c.bookedStartsAt
          ? { startsAt: c.bookedStartsAt, location: s?.displayName ?? null }
          : null,
    labWillCall: c.handoffState === 'PENDING' || c.handoffState === 'ACKNOWLEDGED',
    automatedContact,
    /** The patient can pick a time in the app. */
    canBook:
      status === 'NOT_BOOKED' &&
      automatedContact &&
      ['CONTACTING', 'AWAITING_BOOKING'].includes(c.workflowState) &&
      c.bookingState !== 'UNKNOWN',
    language: c.language,
    simulation: t.simulation,
  };
}
