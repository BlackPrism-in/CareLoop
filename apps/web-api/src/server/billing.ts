import 'server-only';
import type { Case, PilotConfig, Site, Tenant } from '@careloop/contracts';
import {
  buildStatement,
  monthBounds,
  tenantCollection,
  tenantDoc,
  tenantRecord,
  type BillingStatement,
} from '@careloop/domain';
import { HttpError } from './errors';
import { firestore } from './firebase';

/**
 * Issues the statement for a finished month, once. Months are issued in
 * order, and each case is billed in the first statement after it enrolled.
 */
export async function issueStatement(
  tenantId: string,
  month: string,
  actorId: string,
  now = new Date(),
): Promise<{ statement: BillingStatement; created: boolean }> {
  if (monthBounds(month).end > now) throw new HttpError('DOMAIN_GUARD_FAILED', 'MONTH_NOT_ENDED');
  const db = firestore();
  const ref = db.doc(tenantRecord(tenantId, 'invoices', month));
  const existing = await ref.get();
  if (existing.exists) return { statement: existing.data() as BillingStatement, created: false };
  const [tenant, sites, cases, prior, pilot] = await Promise.all([
    db.doc(tenantDoc(tenantId)).get(),
    db.collection(tenantCollection(tenantId, 'sites')).get(),
    db
      .collection(tenantCollection(tenantId, 'cases'))
      .select('caseId', 'siteId', 'workflowState', 'approvedAt', 'pilotArm', 'createdAt')
      .get(),
    db.collection(tenantCollection(tenantId, 'invoices')).get(),
    db.doc(tenantRecord(tenantId, 'pilot', 'config')).get(),
  ]);
  const priorStatements = prior.docs.map((d) => d.data() as BillingStatement);
  if (priorStatements.some((s) => s.month > month))
    throw new HttpError('DOMAIN_GUARD_FAILED', 'LATER_MONTH_ALREADY_ISSUED');
  const statement = buildStatement({
    tenantId,
    month,
    sites: sites.docs.map((d) => d.data() as Site),
    cases: cases.docs.map((d) => d.data() as Case),
    alreadyBilled: new Set(priorStatements.flatMap((s) => s.caseIds)),
    pricing: (pilot.data() as PilotConfig | undefined)?.pricing,
    simulation: (tenant.data() as Tenant | undefined)?.simulation ?? true,
    issuedAt: now.toISOString(),
    issuedBy: actorId,
  });
  try {
    await ref.create(statement); // a concurrent issue loses here instead of double-billing
  } catch {
    return { statement: (await ref.get()).data() as BillingStatement, created: false };
  }
  return { statement, created: true };
}
