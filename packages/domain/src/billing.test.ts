import { describe, expect, it } from 'vitest';
import { buildStatement, monthBounds, statementCsv } from './billing';

const base = {
  workflowState: 'BOOKED' as const,
  approvedAt: '2026-11-02T00:00:00Z',
  pilotArm: null,
  createdAt: '2026-11-01T10:00:00Z',
};
const sites = [
  { siteId: 'north', displayName: 'North' },
  { siteId: 'south', displayName: 'South, Main' },
];
const run = (cases: Parameters<typeof buildStatement>[0]['cases'], billed: string[] = []) =>
  buildStatement({
    tenantId: 't',
    month: '2026-11',
    sites,
    cases,
    alreadyBilled: new Set(billed),
    simulation: true,
    issuedAt: 'x',
    issuedBy: 'u',
  });

describe('billing statement', () => {
  it('charges each site plus each newly enrolled case', () => {
    const s = run([
      { ...base, caseId: 'a', siteId: 'north' },
      { ...base, caseId: 'b', siteId: 'north' },
      { ...base, caseId: 'c', siteId: 'south' },
    ]);
    expect(s.totalInr).toBe(2 * 2999 + 3 * 25);
    expect(s.caseIds).toEqual(['a', 'b', 'c']);
  });

  it("never bills a case twice, nor drafts, pre-approval cancellations, comparison groups or next month's cases", () => {
    const s = run(
      [
        { ...base, caseId: 'old', siteId: 'north' },
        { ...base, caseId: 'draft', siteId: 'north', workflowState: 'DRAFT', approvedAt: null },
        { ...base, caseId: 'cx', siteId: 'north', workflowState: 'CANCELLED', approvedAt: null },
        { ...base, caseId: 'cx2', siteId: 'north', workflowState: 'CANCELLED' },
        { ...base, caseId: 'base', siteId: 'north', pilotArm: 'BASELINE' },
        { ...base, caseId: 'uc', siteId: 'north', pilotArm: 'USUAL_CARE' },
        { ...base, caseId: 'iv', siteId: 'north', pilotArm: 'INTERVENTION' },
        { ...base, caseId: 'dec', siteId: 'north', createdAt: '2026-11-30T19:00:00Z' }, // 1 Dec IST
      ],
      ['old'],
    );
    expect(s.caseIds).toEqual(['cx2', 'iv']);
  });

  it('uses India-time month bounds and exports safe CSV', () => {
    expect(monthBounds('2026-12').end.toISOString()).toBe('2026-12-31T18:30:00.000Z');
    expect(() => monthBounds('2026-13')).toThrow();
    const csv = statementCsv(run([{ ...base, caseId: 'a', siteId: 'south' }]));
    expect(csv).toContain('"South, Main: site fee, 2026-11"');
    expect(csv.trim().split('\n').at(-1)).toBe('2026-11,,Total,,,6023');
  });
});
