import 'server-only';
import type { Case } from '@careloop/contracts';
import { tenantRecord, type EvidenceDoc, type HandoffDoc } from '@careloop/domain';
import { HttpError } from './errors';
import { firestore } from './firebase';

const ID = /^[A-Za-z0-9_-]{1,160}$/;

export async function loadCase(tenantId: string, caseId: string): Promise<Case> {
  if (!ID.test(caseId)) throw new HttpError('NOT_FOUND', 'Case not found');
  const s = await firestore()
    .doc(tenantRecord(tenantId, 'cases', caseId))
    .get();
  if (!s.exists) throw new HttpError('NOT_FOUND', 'Case not found');
  return s.data() as Case;
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
