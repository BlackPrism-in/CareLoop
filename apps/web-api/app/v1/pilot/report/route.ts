import type { Case, Member, PilotConfig } from '@careloop/contracts';
import {
  computePilotReport,
  tenantCollection,
  tenantRecord,
  type EvidenceDoc,
  type ReportInteraction,
} from '@careloop/domain';
import type { BookingDoc } from '@careloop/jobs';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';

export const dynamic = 'force-dynamic';

/**
 * Pilot report (Blueprint p.11). Gathers the pilot's cases, evidence, calls,
 * staff time and integrity checks, then computes every figure with the
 * unit-tested `computePilotReport`. Read-only.
 */
export const GET = staffRoute(async ({ session }) => {
  if (!session.ctx.roles.some((r) => ['OWNER', 'REVIEWER', 'AUDITOR'].includes(r)))
    throw new HttpError('FORBIDDEN', 'Not permitted');
  const db = firestore();
  const t = session.ctx.tenantId;
  const config = (await db.doc(tenantRecord(t, 'pilot', 'config')).get()).data() as
    PilotConfig | undefined;
  if (!config || config.phase === 'NOT_STARTED')
    throw new HttpError('DOMAIN_GUARD_FAILED', 'PILOT_NOT_STARTED');

  const [casesSnap, evidenceSnap, interactionsSnap, timeSnap, bookingsSnap, membersSnap] =
    await Promise.all([
      db
        .collection(tenantCollection(t, 'cases'))
        .where('pilotArm', 'in', ['BASELINE', 'USUAL_CARE', 'INTERVENTION'])
        .limit(5000)
        .get(),
      db
        .collection(tenantCollection(t, 'evidence'))
        .where('status', 'in', ['VERIFIED', 'SELF_REPORTED'])
        .get(),
      db.collection(tenantCollection(t, 'interactions')).limit(10000).get(),
      db.collection(tenantCollection(t, 'time_logs')).limit(20000).get(),
      db.collection(tenantCollection(t, 'bookings')).where('status', '==', 'CONFIRMED').get(),
      db.collection(tenantCollection(t, 'members')).get(),
    ]);
  const cases = casesSnap.docs.map((d) => d.data() as Case);
  const ids = new Set(cases.map((c) => c.caseId));
  const verifiers = new Set(
    membersSnap.docs
      .map((d) => d.data() as Member)
      .filter((m) => m.roleSet.includes('VERIFIER'))
      .map((m) => m.uid),
  );
  const verifiedAt = new Map<string, string>();
  const independent = new Set<string>();
  const selfReported = new Set<string>();
  for (const d of evidenceSnap.docs) {
    const e = d.data() as EvidenceDoc;
    if (!ids.has(e.caseId)) continue;
    if (e.kind === 'SELF_REPORT') selfReported.add(e.caseId);
    if (e.status === 'VERIFIED') {
      verifiedAt.set(e.caseId, e.occurredAt);
      if (
        e.kind === 'PROVIDER_EVENT' ||
        (e.kind === 'STAFF_RECORD' && e.decidedBy && verifiers.has(e.decidedBy))
      )
        independent.add(e.caseId);
    }
  }
  const bookingsPerCase = new Map<string, number>();
  for (const d of bookingsSnap.docs) {
    const b = d.data() as BookingDoc;
    if (ids.has(b.caseId)) bookingsPerCase.set(b.caseId, (bookingsPerCase.get(b.caseId) ?? 0) + 1);
  }
  const interactions: ReportInteraction[] = interactionsSnap.docs
    .map((d) => d.data())
    .filter((x) => ids.has(x.caseId))
    .map((x) => ({
      caseId: x.caseId,
      createdAt: x.createdAt,
      identityAssurance: x.identityAssurance ?? null,
      audioSeconds: x.audioSeconds ?? null,
      reviewStatus: x.reviewStatus ?? null,
      review: x.review ?? null,
      unsupportedClaims: x.unsupportedClaims ?? null,
    }));

  const report = computePilotReport({
    now: new Date(),
    config,
    cases,
    verifiedAt,
    selfReported,
    interactions,
    timeLogs: timeSnap.docs.map(
      (d) => d.data() as { caseId: string | null; pilotArm: Case['pilotArm']; minutes: number },
    ),
    integrity: {
      // contactAttempts only rises through the dispatch command, so this catches any contact outside the intervention group.
      contactOutsideIntervention: cases.filter(
        (c) => c.pilotArm !== 'INTERVENTION' && c.contactAttempts > 0,
      ).length,
      duplicateLiveBookings: [...bookingsPerCase.values()].filter((n) => n > 1).length,
      completionWithoutIndependentEvidence: cases.filter(
        (c) => c.workflowState === 'COMPLETED_VERIFIED' && !independent.has(c.caseId),
      ).length,
    },
    messagesSent: 0, // no messaging provider is connected yet
  });
  const { allocationSalt: _s, ...visibleConfig } = config;
  return Response.json({ ...report, config: visibleConfig, truncated: casesSnap.size >= 5000 });
});
