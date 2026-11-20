import { describe, expect, it } from 'vitest';
import type { PilotConfig } from '@careloop/contracts';
import { allocateArm, automatedContactAllowed } from './pilot';

const cfg = (o: Partial<PilotConfig> = {}): PilotConfig => ({
  phase: 'INTERVENTION',
  baselineStartedAt: null,
  interventionStartedAt: null,
  endedAt: null,
  concurrentComparison: true,
  interventionShare: 0.5,
  allocationSalt: 'secret-salt-0123456789',
  supervisedReviewFirstN: 50,
  costRates: {
    voicePerMinuteInr: 1,
    messageInr: 0.5,
    modelPerCaseInr: 2,
    directSupportPerMonthInr: 1500,
  },
  pricing: { sitePerMonthInr: 2999, perEnrolledCaseInr: 25 },
  updatedBy: 'u',
  updatedAt: '2026-11-20T00:00:00Z',
  ...o,
});

describe('pilot allocation', () => {
  it('no pilot → no group; baseline → BASELINE; no comparison → all INTERVENTION', () => {
    expect(allocateArm(null, 'CL-1')).toBeNull();
    expect(allocateArm(cfg({ phase: 'NOT_STARTED' }), 'CL-1')).toBeNull();
    expect(allocateArm(cfg({ phase: 'BASELINE' }), 'CL-1')).toBe('BASELINE');
    expect(allocateArm(cfg({ concurrentComparison: false }), 'CL-1')).toBe('INTERVENTION');
  });
  it('is deterministic per case and close to the configured share', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `CL-${i}`);
    expect(ids.map((id) => allocateArm(cfg(), id))).toEqual(
      ids.map((id) => allocateArm(cfg(), id)),
    );
    const share = ids.filter((id) => allocateArm(cfg(), id) === 'INTERVENTION').length / ids.length;
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
  });
  it('a different salt gives a different allocation (staff cannot precompute it)', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `CL-${i}`);
    const a = ids.map((id) => allocateArm(cfg(), id));
    const b = ids.map((id) => allocateArm(cfg({ allocationSalt: 'another-salt-987654321' }), id));
    expect(a).not.toEqual(b);
  });
  it('only the intervention group (or no pilot) may be contacted automatically', () => {
    expect(automatedContactAllowed(null)).toBe(true);
    expect(automatedContactAllowed('INTERVENTION')).toBe(true);
    expect(automatedContactAllowed('BASELINE')).toBe(false);
    expect(automatedContactAllowed('USUAL_CARE')).toBe(false);
  });
});
