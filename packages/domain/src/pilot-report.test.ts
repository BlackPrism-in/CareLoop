import { describe, expect, it } from 'vitest';
import type { Case, PilotConfig } from '@careloop/contracts';
import { computePilotReport, newcombe, wilson, type PilotReportInput } from './pilot-report';

describe('interval statistics', () => {
  it('Wilson matches published values', () => {
    const w = wilson(50, 100)!;
    expect(w.low).toBeCloseTo(0.4038, 3);
    expect(w.high).toBeCloseTo(0.5962, 3);
    expect(wilson(0, 0)).toBeNull();
    const z = wilson(0, 20)!;
    expect(z.low).toBe(0);
    expect(z.high).toBeCloseTo(0.1611, 3);
  });
  it('Newcombe difference interval (Newcombe 1998, example: 56/70 vs 48/80)', () => {
    const d = newcombe(56, 70, 48, 80)!;
    expect(d.diff).toBeCloseTo(0.2, 4);
    expect(d.low).toBeCloseTo(0.0524, 3);
    expect(d.high).toBeCloseTo(0.3339, 3);
  });
});

const config: PilotConfig = {
  phase: 'ENDED',
  baselineStartedAt: '2026-10-01T00:00:00Z',
  interventionStartedAt: '2026-10-15T00:00:00Z',
  endedAt: '2026-11-15T00:00:00Z',
  concurrentComparison: true,
  interventionShare: 0.5,
  allocationSalt: 'salt-salt-salt-salt',
  supervisedReviewFirstN: 2,
  costRates: {
    voicePerMinuteInr: 2,
    messageInr: 0.5,
    modelPerCaseInr: 1,
    directSupportPerMonthInr: 1000,
  },
  pricing: { sitePerMonthInr: 2999, perEnrolledCaseInr: 25 },
  updatedBy: 'u',
  updatedAt: '2026-11-15T00:00:00Z',
};

function mk(arm: Case['pilotArm'], n: number, done: number, extra: Partial<Case> = {}): Case[] {
  return Array.from({ length: n }, (_, k) => ({
    caseId: `${arm}-${k}`,
    pilotArm: arm,
    approvalRevision: 1,
    dueAt: '2026-11-10T00:00:00Z',
    workflowState: k < done ? 'COMPLETED_VERIFIED' : 'AWAITING_EVIDENCE',
    language: k % 2 ? 'hi-IN' : 'en-IN',
    outreachDisposition: 'REACHED',
    contactAttempts: arm === 'INTERVENTION' ? 1 : 0,
    ...extra,
  })) as Case[];
}

function input(o: Partial<PilotReportInput> = {}): PilotReportInput {
  const cases = [
    ...mk('BASELINE', 40, 10),
    ...mk('USUAL_CARE', 40, 12),
    ...mk('INTERVENTION', 40, 24),
  ];
  return {
    now: new Date('2026-11-20T00:00:00Z'),
    config,
    cases,
    verifiedAt: new Map(
      cases
        .filter((c) => c.workflowState === 'COMPLETED_VERIFIED')
        .map((c) => [c.caseId, '2026-11-05T00:00:00Z']),
    ),
    selfReported: new Set(['USUAL_CARE-30']),
    interactions: cases
      .filter((c) => c.pilotArm === 'INTERVENTION')
      .slice(0, 30)
      .map(
        (c, k) =>
          ({
            caseId: c.caseId,
            createdAt: '2026-11-01T00:00:00Z',
            identityAssurance: 'VERIFIED',
            audioSeconds: 120,
            reviewStatus: k < 2 ? 'REVIEWED' : 'NOT_REQUIRED',
            review:
              k < 2 ? { outcome: k === 0 ? 'OK' : 'ISSUE', issues: k === 0 ? [] : ['TONE'] } : null,
            unsupportedClaims: 0,
          }) as const,
      ),
    timeLogs: [
      ...mk('BASELINE', 40, 0).map((c) => ({
        caseId: c.caseId,
        pilotArm: 'BASELINE' as const,
        minutes: 10,
      })),
      ...mk('INTERVENTION', 40, 0).map((c) => ({
        caseId: c.caseId,
        pilotArm: 'INTERVENTION' as const,
        minutes: 6,
      })),
    ],
    integrity: {
      contactOutsideIntervention: 0,
      duplicateLiveBookings: 0,
      completionWithoutIndependentEvidence: 0,
    },
    messagesSent: 10,
    ...o,
  };
}

describe('computePilotReport', () => {
  it('computes per-group outcomes, comparisons and every gate', () => {
    const r = computePilotReport(input());
    expect(r.arms.INTERVENTION.rate!.p).toBeCloseTo(0.6);
    expect(r.arms.USUAL_CARE.rate!.p).toBeCloseTo(0.3);
    expect(r.comparisons.interventionVsUsualCare!.diff).toBeCloseTo(0.3);
    expect(r.arms.USUAL_CARE.selfReportedOnly).toBe(1);
    const g = Object.fromEntries(r.gates.map((x) => [x.name.split(':')[0], x.status]));
    expect(g['Feasibility']).toBe('MET'); // 30/40 = 75%
    expect(g['Incremental value vs concurrent usual care']).toBe('MET');
    expect(g['Workload']).toBe('MET'); // 600 vs 1000 min per 100 cases = 40% less
    expect(g['Reliability']).toBe('MET');
    expect(g['Supervised review of the first live calls']).toBe('MET');
    expect(g['Commercial']).toBe('RECORD_MANUALLY');
    expect(r.cost.voiceMinutes).toBe(60);
    expect(r.cost.variableCostInr).toBe(60 * 2 + 10 * 0.5 + 40 * 1);
    expect(r.reviews.issues).toEqual({ TONE: 1 });
  });

  it('excludes open windows and cancellations, and refuses to judge small samples', () => {
    const small = [
      ...mk('USUAL_CARE', 5, 1),
      ...mk('INTERVENTION', 5, 4),
      ...mk('INTERVENTION', 3, 0, { dueAt: '2026-12-30T00:00:00Z' }).map((c, k) => ({
        ...c,
        caseId: `open-${k}`,
      })),
      ...mk('INTERVENTION', 2, 0, { workflowState: 'CANCELLED' }).map((c, k) => ({
        ...c,
        caseId: `cx-${k}`,
      })),
    ];
    const r = computePilotReport(
      input({
        cases: small,
        verifiedAt: new Map(
          small
            .filter((c) => c.workflowState === 'COMPLETED_VERIFIED')
            .map((c) => [c.caseId, '2026-11-05T00:00:00Z']),
        ),
        interactions: [],
        timeLogs: [],
      }),
    );
    expect(r.arms.INTERVENTION.eligible).toBe(5);
    expect(r.arms.INTERVENTION.excludedWindowOpen).toBe(3);
    expect(r.arms.INTERVENTION.excludedCancelled).toBe(2);
    expect(r.gates.find((x) => x.name.startsWith('Incremental'))!.status).toBe('NOT_ENOUGH_DATA');
  });

  it('completion after the due date does not count as on time; any integrity breach fails the gate', () => {
    const cases = mk('INTERVENTION', 40, 40);
    const late = new Map(cases.map((c) => [c.caseId, '2026-11-12T00:00:00Z']));
    const r = computePilotReport(
      input({
        cases,
        verifiedAt: late,
        integrity: {
          contactOutsideIntervention: 1,
          duplicateLiveBookings: 0,
          completionWithoutIndependentEvidence: 0,
        },
      }),
    );
    expect(r.arms.INTERVENTION.verifiedOnTime).toBe(0);
    expect(r.gates.find((x) => x.name.startsWith('Reliability'))!.status).toBe('NOT_MET');
  });

  it('does not claim reliability or a margin it cannot know', () => {
    const r = computePilotReport(
      input({
        cases: mk('BASELINE', 5, 0),
        config: {
          ...config,
          costRates: {
            voicePerMinuteInr: 0,
            messageInr: 0,
            modelPerCaseInr: 0,
            directSupportPerMonthInr: 0,
          },
        },
      }),
    );
    expect(r.gates.find((x) => x.name.startsWith('Reliability'))!.status).toBe('NOT_ENOUGH_DATA');
    expect(r.cost.grossMargin).toBeNull();
    expect(r.cost.ratesConfigured).toBe(false);
  });
});
