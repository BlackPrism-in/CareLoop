import { z } from 'zod';
import type { Case } from '@careloop/contracts';
import { canAccessSite, tenantCollection, type EvidenceDoc, type HandoffDoc } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cohort: z.enum(['due', 'created']).default('due'),
  site: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
});

const MAX_CASES = 2000;

/**
 * Cohort metrics (MVP-12, MVP spec §18). Bookings, self-reports and verified
 * completions are counted separately. The primary rate uses only obligations
 * whose follow-up window has closed, and lists every exclusion. No clinical
 * outcome is inferred.
 */
export const GET = staffRoute(async ({ req, session }) => {
  const q = Query.parse(Object.fromEntries(new URL(req.url).searchParams));
  const db = firestore();
  const t = session.ctx.tenantId;
  const field = q.cohort === 'due' ? 'dueAt' : 'createdAt';
  const fromIso = new Date(`${q.from}T00:00:00+05:30`).toISOString();
  const toIso = new Date(`${q.to}T23:59:59.999+05:30`).toISOString();
  const snap = await db
    .collection(tenantCollection(t, 'cases'))
    .where(field, '>=', fromIso)
    .where(field, '<=', toIso)
    .limit(MAX_CASES + 1)
    .get();
  const cases = snap.docs.slice(0, MAX_CASES).map((d) => d.data() as Case).filter((c) => canAccessSite(session.ctx, c.siteId) && (!q.site || c.siteId === q.site));
  const ids = new Set(cases.map((c) => c.caseId));

  const [evidence, handoffs] = await Promise.all([
    db
      .collection(tenantCollection(t, 'evidence'))
      .where('status', 'in', ['VERIFIED', 'SELF_REPORTED'])
      .get(),
    db.collection(tenantCollection(t, 'handoffs')).get(),
  ]);
  const verifiedAt = new Map<string, string>();
  const selfReported = new Set<string>();
  for (const d of evidence.docs) {
    const e = d.data() as EvidenceDoc;
    if (!ids.has(e.caseId)) continue;
    if (e.status === 'VERIFIED') verifiedAt.set(e.caseId, e.occurredAt);
    if (e.kind === 'SELF_REPORT') selfReported.add(e.caseId);
  }
  const hs = handoffs.docs.map((d) => d.data() as HandoffDoc).filter((h) => ids.has(h.caseId));

  const now = Date.now();
  const enrolled = cases.filter((c) => c.approvalRevision > 0);
  const cancelled = enrolled.filter((c) => c.workflowState === 'CANCELLED');
  const windowOpen = enrolled.filter(
    (c) => c.workflowState !== 'CANCELLED' && Date.parse(c.dueAt) > now,
  );
  const eligible = enrolled.filter(
    (c) => c.workflowState !== 'CANCELLED' && Date.parse(c.dueAt) <= now,
  );
  const verified = enrolled.filter((c) => c.workflowState === 'COMPLETED_VERIFIED');
  const verifiedOnTime = eligible.filter(
    (c) =>
      c.workflowState === 'COMPLETED_VERIFIED' &&
      verifiedAt.has(c.caseId) &&
      Date.parse(verifiedAt.get(c.caseId)!) <= Date.parse(c.dueAt),
  );
  const everBooked = enrolled.filter(
    (c) => c.bookingRef !== null || ['BOOKED', 'AWAITING_EVIDENCE'].includes(c.workflowState),
  );
  const ackMinutes = hs
    .filter((h) => h.acknowledgedAt)
    .map((h) => (Date.parse(h.acknowledgedAt!) - Date.parse(h.createdAt)) / 60_000)
    .sort((a, b) => a - b);
  const count = (pred: (c: Case) => boolean) => enrolled.filter(pred).length;

  return Response.json({
    cohort: {
      by: q.cohort,
      from: q.from,
      to: q.to,
      cases: cases.length,
      truncated: snap.size > MAX_CASES,
      drafts: cases.length - enrolled.length,
    },
    primary: {
      label: 'Verified completion by the approved due date',
      numerator: verifiedOnTime.length,
      denominator: eligible.length,
      rate: eligible.length ? verifiedOnTime.length / eligible.length : null,
      exclusions: {
        cancelled: cancelled.length,
        followUpWindowStillOpen: windowOpen.length,
        notYetApproved: cases.length - enrolled.length,
      },
    },
    separateCounts: {
      enrolled: enrolled.length,
      contacted: count((c) => c.contactAttempts > 0),
      booked: everBooked.length,
      selfReportedOnly: [...selfReported].filter((id) => !verifiedAt.has(id)).length,
      verifiedCompleted: verified.length,
      verifiedWithoutCareLoopBooking: verified.filter((c) => c.bookingRef === null).length,
    },
    dispositions: {
      optedOut: count((c) => c.outreachDisposition === 'OPTED_OUT'),
      declined: count((c) => c.outreachDisposition === 'DECLINED'),
      unreachable: count((c) => c.outreachDisposition === 'UNREACHABLE'),
      cancelled: cancelled.length,
      stillOpen: count((c) => !['COMPLETED_VERIFIED', 'CANCELLED'].includes(c.workflowState)),
    },
    staffEffort: {
      handoffs: hs.length,
      handoffsOpen: hs.filter((h) => h.status !== 'RESOLVED').length,
      medianAcknowledgeMinutes: ackMinutes.length
        ? Math.round(ackMinutes[Math.floor(ackMinutes.length / 2)]!)
        : null,
      contactAttempts: enrolled.reduce((n, c) => n + c.contactAttempts, 0),
      billedVoiceMinutes: Math.round(enrolled.reduce((n, c) => n + c.audioSecondsUsed, 0) / 6) / 10,
    },
    asOf: new Date().toISOString(),
  });
});
