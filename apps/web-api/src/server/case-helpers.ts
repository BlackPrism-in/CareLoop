import 'server-only';
import type { Case } from '@careloop/contracts';
import { canAccessSite, tenantRecord, type EvidenceDoc, type HandoffDoc } from '@careloop/domain';
import { HttpError } from './errors';
import { firestore } from './firebase';

const ID = /^[A-Za-z0-9_-]{1,160}$/;

export async function loadCase(
  tenantId: string,
  caseId: string,
  scope?: readonly string[] | 'ALL',
): Promise<Case> {
  if (!ID.test(caseId)) throw new HttpError('NOT_FOUND', 'Case not found');
  const s = await firestore().doc(tenantRecord(tenantId, 'cases', caseId)).get();
  if (!s.exists) throw new HttpError('NOT_FOUND', 'Case not found');
  const c = s.data() as Case;
  // A case at a site outside the caller's scope is indistinguishable from a missing one.
  if (!canAccessSite({ siteIds: scope }, c.siteId)) throw new HttpError('NOT_FOUND', 'Case not found');
  return c;
}

export async function loadEvidence(tenantId: string, id: string): Promise<EvidenceDoc> {
  if (!ID.test(id)) throw new HttpError('NOT_FOUND', 'Evidence not found');
  const s = await firestore()
    .doc(tenantRecord(tenantId, 'evidence', id))
    .get();
  if (!s.exists) throw new HttpError('NOT_FOUND', 'Evidence not found');
  return s.data() as EvidenceDoc;
}

export async function loadHandoff(tenantId: string, id: string): Promise<HandoffDoc> {
  if (!ID.test(id)) throw new HttpError('NOT_FOUND', 'Handoff not found');
  const s = await firestore()
    .doc(tenantRecord(tenantId, 'handoffs', id))
    .get();
  if (!s.exists) throw new HttpError('NOT_FOUND', 'Handoff not found');
  return s.data() as HandoffDoc;
}

/** Keeps only rows whose case is at a site the caller may see (one batched read). */
export async function filterBySite<T extends { caseId: string }>(tenantId: string, rows: T[], scope?: readonly string[] | 'ALL'): Promise<T[]> {
  if (scope === undefined || scope === 'ALL' || rows.length === 0) return rows;
  const db = firestore();
  const ids = [...new Set(rows.map((r) => r.caseId))];
  const snaps = await db.getAll(...ids.map((id) => db.doc(tenantRecord(tenantId, 'cases', id))));
  const allowed = new Set(snaps.filter((s) => s.exists && canAccessSite({ siteIds: scope }, (s.data() as Case).siteId)).map((s) => s.id));
  return rows.filter((r) => allowed.has(r.caseId));
}
