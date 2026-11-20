import type { Case, Site } from '@careloop/contracts';

/**
 * Monthly billing statement (Phase 9). Pricing from the blueprint: a fixed
 * fee per site per month plus a fee per enrolled case.
 *
 * "Enrolled" means a reviewer approved the case for CareLoop follow-up: it
 * left DRAFT, it is not in a baseline or usual-care pilot group (those are
 * tracked but CareLoop never contacts them), and it was created before the
 * month ended. Each case is billed once, in the first statement after it
 * enrolled, so a case open for three months is not charged three times.
 *
 * Amounts are whole rupees. This is a usage statement, not a GST tax
 * invoice; the lab's accounting system issues that with GSTIN and SAC codes.
 */
export interface Pricing {
  sitePerMonthInr: number;
  perEnrolledCaseInr: number;
}
export const DEFAULT_PRICING: Pricing = { sitePerMonthInr: 2999, perEnrolledCaseInr: 25 };

export interface StatementLine {
  kind: 'SITE' | 'ENROLLED_CASES';
  siteId: string;
  description: string;
  quantity: number;
  unitInr: number;
  amountInr: number;
}

export interface BillingStatement {
  statementId: string;
  tenantId: string;
  month: string;
  pricing: Pricing;
  lines: StatementLine[];
  totalInr: number;
  /** Cases billed in this statement; never billed again. */
  caseIds: string[];
  simulation: boolean;
  issuedAt: string;
  issuedBy: string;
}

export function monthBounds(month: string): { start: Date; end: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('month must be YYYY-MM');
  // Month boundaries in India time.
  const start = new Date(`${month}-01T00:00:00+05:30`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start, end: new Date(`${next}-01T00:00:00+05:30`) };
}

export function isEnrolled(c: Pick<Case, 'workflowState' | 'approvedAt' | 'pilotArm'>): boolean {
  if (c.pilotArm === 'BASELINE' || c.pilotArm === 'USUAL_CARE') return false;
  if (c.workflowState === 'DRAFT') return false;
  // Cancelled before anyone approved it: never enrolled.
  if (c.workflowState === 'CANCELLED' && !c.approvedAt) return false;
  return true;
}

export function buildStatement(i: {
  tenantId: string;
  month: string;
  sites: Pick<Site, 'siteId' | 'displayName'>[];
  cases: Pick<Case, 'caseId' | 'siteId' | 'workflowState' | 'approvedAt' | 'pilotArm' | 'createdAt'>[];
  alreadyBilled: ReadonlySet<string>;
  pricing?: Pricing;
  simulation: boolean;
  issuedAt: string;
  issuedBy: string;
}): BillingStatement {
  const pricing = i.pricing ?? DEFAULT_PRICING;
  const { end } = monthBounds(i.month);
  const billable = i.cases.filter(
    (c) => !i.alreadyBilled.has(c.caseId) && Date.parse(c.createdAt) < end.getTime() && isEnrolled(c),
  );
  const bySite = new Map<string, string[]>();
  for (const c of billable) bySite.set(c.siteId, [...(bySite.get(c.siteId) ?? []), c.caseId]);
  const lines: StatementLine[] = [];
  for (const s of [...i.sites].sort((a, b) => a.siteId.localeCompare(b.siteId))) {
    lines.push({
      kind: 'SITE',
      siteId: s.siteId,
      description: `${s.displayName}: site fee, ${i.month}`,
      quantity: 1,
      unitInr: pricing.sitePerMonthInr,
      amountInr: pricing.sitePerMonthInr,
    });
    const n = bySite.get(s.siteId)?.length ?? 0;
    if (n)
      lines.push({
        kind: 'ENROLLED_CASES',
        siteId: s.siteId,
        description: `${s.displayName}: newly enrolled follow-ups`,
        quantity: n,
        unitInr: pricing.perEnrolledCaseInr,
        amountInr: n * pricing.perEnrolledCaseInr,
      });
  }
  // Cases at a site that no longer exists are still billed, on their own line.
  for (const [siteId, ids] of bySite)
    if (!i.sites.some((s) => s.siteId === siteId))
      lines.push({
        kind: 'ENROLLED_CASES',
        siteId,
        description: `${siteId}: newly enrolled follow-ups`,
        quantity: ids.length,
        unitInr: pricing.perEnrolledCaseInr,
        amountInr: ids.length * pricing.perEnrolledCaseInr,
      });
  return {
    statementId: `${i.tenantId}_${i.month}`,
    tenantId: i.tenantId,
    month: i.month,
    pricing,
    lines,
    totalInr: lines.reduce((n, l) => n + l.amountInr, 0),
    caseIds: billable.map((c) => c.caseId).sort(),
    simulation: i.simulation,
    issuedAt: i.issuedAt,
    issuedBy: i.issuedBy,
  };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  // Quote, and neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function statementCsv(s: BillingStatement): string {
  const rows: (string | number)[][] = [
    ['month', 'site_id', 'item', 'quantity', 'unit_inr', 'amount_inr'],
    ...s.lines.map((l) => [s.month, l.siteId, l.description, l.quantity, l.unitInr, l.amountInr]),
    [s.month, '', 'Total', '', '', s.totalInr],
  ];
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
