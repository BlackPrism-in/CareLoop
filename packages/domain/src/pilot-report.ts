import type { Case, PilotArm, PilotConfig } from '@careloop/contracts';

/**
 * Pilot report (Blueprint p.11 "A practical pilot" and its measures table).
 * Pure: the API gathers the data, this computes every number, so each figure
 * is unit-tested. Rates come with Wilson 95% intervals; differences with
 * Newcombe intervals. Small samples are flagged, and before/after comparisons
 * are labelled as not causal.
 */

const Z = 1.959964;

export function wilson(
  successes: number,
  n: number,
): { p: number; low: number; high: number } | null {
  if (n === 0) return null;
  const p = successes / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Newcombe hybrid score interval for p1 − p2. */
export function newcombe(
  s1: number,
  n1: number,
  s2: number,
  n2: number,
): { diff: number; low: number; high: number } | null {
  const a = wilson(s1, n1);
  const b = wilson(s2, n2);
  if (!a || !b) return null;
  const d = a.p - b.p;
  return {
    diff: d,
    low: d - Math.sqrt((a.p - a.low) ** 2 + (b.high - b.p) ** 2),
    high: d + Math.sqrt((a.high - a.p) ** 2 + (b.p - b.low) ** 2),
  };
}

export interface ReportInteraction {
  caseId: string;
  createdAt: string;
  identityAssurance: string | null;
  audioSeconds: number | null;
  reviewStatus: string | null;
  review: { outcome: 'OK' | 'ISSUE'; issues: string[] } | null;
  unsupportedClaims: number | null;
}

export interface PilotReportInput {
  now: Date;
  config: PilotConfig;
  cases: Case[];
  /** caseId → occurredAt of the verified completion evidence. */
  verifiedAt: Map<string, string>;
  selfReported: Set<string>;
  interactions: ReportInteraction[];
  timeLogs: { caseId: string | null; pilotArm: PilotArm | null; minutes: number }[];
  /** Integrity checks computed from stored data by the caller. */
  integrity: {
    contactOutsideIntervention: number;
    duplicateLiveBookings: number;
    completionWithoutIndependentEvidence: number;
  };
  messagesSent: number;
}

type Gate = {
  name: string;
  target: string;
  value: string;
  status: 'MET' | 'NOT_MET' | 'NOT_ENOUGH_DATA' | 'RECORD_MANUALLY';
};

const MIN_N = 30; // below this, rates are shown but gates are not judged
const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`;

export function computePilotReport(i: PilotReportInput) {
  const now = i.now.getTime();
  const arms: PilotArm[] = ['BASELINE', 'USUAL_CARE', 'INTERVENTION'];
  const inPilot = i.cases.filter((c) => c.pilotArm !== null && c.approvalRevision > 0);

  const byArm = Object.fromEntries(
    arms.map((arm) => {
      const enrolled = inPilot.filter((c) => c.pilotArm === arm);
      const eligible = enrolled.filter(
        (c) => c.workflowState !== 'CANCELLED' && Date.parse(c.dueAt) <= now,
      );
      const onTime = eligible.filter(
        (c) =>
          c.workflowState === 'COMPLETED_VERIFIED' &&
          i.verifiedAt.has(c.caseId) &&
          Date.parse(i.verifiedAt.get(c.caseId)!) <= Date.parse(c.dueAt),
      );
      const minutes = i.timeLogs
        .filter((t) => t.pilotArm === arm)
        .reduce((n, t) => n + t.minutes, 0);
      const casesWithTime = new Set(
        i.timeLogs.filter((t) => t.pilotArm === arm && t.caseId).map((t) => t.caseId),
      ).size;
      return [
        arm,
        {
          enrolled: enrolled.length,
          eligible: eligible.length,
          excludedWindowOpen: enrolled.filter(
            (c) => c.workflowState !== 'CANCELLED' && Date.parse(c.dueAt) > now,
          ).length,
          excludedCancelled: enrolled.filter((c) => c.workflowState === 'CANCELLED').length,
          verifiedOnTime: onTime.length,
          rate: wilson(onTime.length, eligible.length),
          selfReportedOnly: enrolled.filter(
            (c) => i.selfReported.has(c.caseId) && c.workflowState !== 'COMPLETED_VERIFIED',
          ).length,
          staffMinutes: minutes,
          staffMinutesPer100: enrolled.length
            ? Math.round((minutes / enrolled.length) * 100)
            : null,
          timeLogCoverage: enrolled.length ? casesWithTime / enrolled.length : null,
        },
      ];
    }),
  ) as Record<
    PilotArm,
    {
      enrolled: number;
      eligible: number;
      excludedWindowOpen: number;
      excludedCancelled: number;
      verifiedOnTime: number;
      rate: ReturnType<typeof wilson>;
      selfReportedOnly: number;
      staffMinutes: number;
      staffMinutesPer100: number | null;
      timeLogCoverage: number | null;
    }
  >;

  const I = byArm.INTERVENTION;
  const U = byArm.USUAL_CARE;
  const B = byArm.BASELINE;
  const concurrent = newcombe(I.verifiedOnTime, I.eligible, U.verifiedOnTime, U.eligible);
  const beforeAfter = newcombe(I.verifiedOnTime, I.eligible, B.verifiedOnTime, B.eligible);

  // Feasibility: identity-verified contact before the due date, intervention cases with a closed window.
  const intervention = inPilot.filter((c) => c.pilotArm === 'INTERVENTION');
  const verifiedContact = (c: Case) =>
    i.interactions.some(
      (x) =>
        x.caseId === c.caseId &&
        (x.identityAssurance === 'VERIFIED' || x.identityAssurance === 'SIMULATED') &&
        Date.parse(x.createdAt) <= Date.parse(c.dueAt),
    );
  const feasDenom = intervention.filter(
    (c) => c.workflowState !== 'CANCELLED' && (Date.parse(c.dueAt) <= now || verifiedContact(c)),
  );
  const feasNum = feasDenom.filter(verifiedContact);
  const byLanguage = Object.fromEntries(
    (['hi-IN', 'en-IN', 'bn-IN'] as const).map((lang) => {
      const d = feasDenom.filter((c) => c.language === lang);
      return [lang, wilson(d.filter(verifiedContact).length, d.length)];
    }),
  );
  const failureCauses = {
    unreachable: intervention.filter((c) => c.outreachDisposition === 'UNREACHABLE').length,
    declined: intervention.filter((c) => c.outreachDisposition === 'DECLINED').length,
    optedOut: intervention.filter((c) => c.outreachDisposition === 'OPTED_OUT').length,
    neverContacted: intervention.filter((c) => c.contactAttempts === 0).length,
  };

  // Reviews of the first live calls.
  const reviewed = i.interactions.filter((x) => x.reviewStatus === 'REVIEWED');
  const issues: Record<string, number> = {};
  for (const x of reviewed)
    for (const k of x.review?.issues ?? []) issues[k] = (issues[k] ?? 0) + 1;

  // Cost: metered usage × configured rates, for CareLoop-enrolled (intervention) cases.
  const interventionIds = new Set(intervention.map((c) => c.caseId));
  const voiceMinutes =
    i.interactions
      .filter((x) => interventionIds.has(x.caseId))
      .reduce((n, x) => n + (x.audioSeconds ?? 0), 0) / 60;
  const r = i.config.costRates;
  const variable =
    voiceMinutes * r.voicePerMinuteInr +
    i.messagesSent * r.messageInr +
    intervention.length * r.modelPerCaseInr;
  const months = Math.max(
    1,
    (now -
      Date.parse(
        i.config.interventionStartedAt ?? i.config.baselineStartedAt ?? i.now.toISOString(),
      )) /
      (30 * 86_400_000),
  );
  const support = r.directSupportPerMonthInr * months;
  const fee =
    i.config.pricing.sitePerMonthInr * months +
    i.config.pricing.perEnrolledCaseInr * intervention.length;
  const cost = {
    voiceMinutes: Math.round(voiceMinutes * 10) / 10,
    messagesSent: i.messagesSent,
    variableCostInr: Math.round(variable),
    variableCostPerCaseInr: intervention.length
      ? Math.round((variable / intervention.length) * 10) / 10
      : null,
    directSupportInr: Math.round(support),
    feeAtProposedPriceInr: Math.round(fee),
    /** Margin is withheld until real cost rates are entered (all-zero rates would show a meaningless 100%). */
    ratesConfigured: Object.values(r).some((x) => x > 0),
    grossMargin:
      fee > 0 && Object.values(r).some((x) => x > 0) ? (fee - variable - support) / fee : null,
    months: Math.round(months * 10) / 10,
  };

  const workloadReduction =
    B.staffMinutesPer100 && I.staffMinutesPer100 !== null
      ? 1 - I.staffMinutesPer100 / B.staffMinutesPer100
      : null;
  const integrityTotal =
    i.integrity.contactOutsideIntervention +
    i.integrity.duplicateLiveBookings +
    i.integrity.completionWithoutIndependentEvidence;
  const enough = (n: number) => n >= MIN_N;
  const gates: Gate[] = [
    {
      name: 'Feasibility: identity-verified contact within the outreach window',
      target: '≥ 60%',
      value: `${pct(feasDenom.length ? feasNum.length / feasDenom.length : null)} (${feasNum.length}/${feasDenom.length})`,
      status: !enough(feasDenom.length)
        ? 'NOT_ENOUGH_DATA'
        : feasNum.length / feasDenom.length >= 0.6
          ? 'MET'
          : 'NOT_MET',
    },
    {
      name: 'Incremental value vs concurrent usual care',
      target: '+10 pp (exploratory)',
      value: concurrent
        ? `${(concurrent.diff * 100).toFixed(1)} pp (95% CI ${(concurrent.low * 100).toFixed(1)} to ${(concurrent.high * 100).toFixed(1)})`
        : '—',
      status:
        !concurrent || !enough(I.eligible) || !enough(U.eligible)
          ? 'NOT_ENOUGH_DATA'
          : concurrent.diff >= 0.1
            ? 'MET'
            : 'NOT_MET',
    },
    {
      name: 'Workload: staff minutes per 100 cases vs baseline',
      target: '≥ 30% reduction',
      value:
        workloadReduction === null
          ? '—'
          : `${pct(workloadReduction)} (${I.staffMinutesPer100} vs ${B.staffMinutesPer100} min)`,
      status:
        workloadReduction === null ||
        !enough(B.enrolled) ||
        !enough(I.enrolled) ||
        (I.timeLogCoverage ?? 0) < 0.8 ||
        (B.timeLogCoverage ?? 0) < 0.8
          ? 'NOT_ENOUGH_DATA'
          : workloadReduction >= 0.3
            ? 'MET'
            : 'NOT_MET',
    },
    {
      name: 'Reliability: unauthorized contact, duplicate booking, false completion',
      target: '0',
      value: String(integrityTotal),
      // Zero breaches across zero CareLoop cases proves nothing.
      status:
        integrityTotal > 0 ? 'NOT_MET' : intervention.length === 0 ? 'NOT_ENOUGH_DATA' : 'MET',
    },
    {
      name: 'Supervised review of the first live calls',
      target: `${i.config.supervisedReviewFirstN} reviewed`,
      value: `${reviewed.length} reviewed, ${i.interactions.filter((x) => x.reviewStatus === 'PENDING').length} pending, ${reviewed.filter((x) => x.review?.outcome === 'ISSUE').length} with issues`,
      status: reviewed.length >= i.config.supervisedReviewFirstN ? 'MET' : 'NOT_ENOUGH_DATA',
    },
    {
      name: 'Commercial: sites accepting paid continuation at an explicit price',
      target: '≥ 2 sites',
      value: 'Record outside CareLoop',
      status: 'RECORD_MANUALLY',
    },
  ];

  const limitations = [
    'Rates use only obligations whose due date has passed; cases still inside their window are excluded and listed.',
    `Gates are not judged with fewer than ${MIN_N} cases per group; intervals are wide at pilot scale.`,
    'The intervention vs baseline comparison is before/after and does not establish causality.',
    'Completion elsewhere counts only when independently verified; self-reports are shown separately and excluded.',
    'Staff minutes depend on staff logging their time; coverage is shown per group.',
    'Costs are metered usage × configured rates plus allocated direct support; sales, R&D and taxes are excluded.',
  ];

  return {
    generatedAt: i.now.toISOString(),
    phase: i.config.phase,
    period: {
      baselineStartedAt: i.config.baselineStartedAt,
      interventionStartedAt: i.config.interventionStartedAt,
      endedAt: i.config.endedAt,
    },
    design: {
      concurrentComparison: i.config.concurrentComparison,
      interventionShare: i.config.interventionShare,
    },
    arms: byArm,
    comparisons: {
      interventionVsUsualCare: concurrent,
      interventionVsBaseline: beforeAfter,
      beforeAfterIsNotCausal: true,
    },
    feasibility: {
      verifiedContact: feasNum.length,
      denominator: feasDenom.length,
      byLanguage,
      failureCauses,
    },
    reviews: {
      reviewed: reviewed.length,
      withIssues: reviewed.filter((x) => x.review?.outcome === 'ISSUE').length,
      issues,
      flaggedClaims: i.interactions.reduce((n, x) => n + (x.unsupportedClaims ?? 0), 0),
    },
    integrity: i.integrity,
    cost,
    gates,
    limitations,
  };
}

export type PilotReport = ReturnType<typeof computePilotReport>;
