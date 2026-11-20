import type { Case } from '@careloop/contracts';
import { hashPayload } from './hashing';

/**
 * Fields whose change invalidates an approval (MVP spec §07, §12): the patient,
 * the exact action, and the deadline — plus the site and source it came from.
 */
export const MATERIAL_FIELDS = [
  'patientId',
  'siteId',
  'sourceId',
  'actionType',
  'actionText',
  'dueAt',
] as const satisfies readonly (keyof Case)[];
export type MaterialField = (typeof MATERIAL_FIELDS)[number];

export function approvalHash(c: Pick<Case, MaterialField | 'approvalRevision'>): string {
  const material = Object.fromEntries(MATERIAL_FIELDS.map((f) => [f, c[f]]));
  return hashPayload({ revision: c.approvalRevision, ...material });
}

/** True when the case still matches what the reviewer approved. */
export function approvalIsCurrent(c: Case): boolean {
  return c.approvalRevision > 0 && c.approvalHash !== null && c.approvalHash === approvalHash(c);
}

/** Fields a reviewer must explicitly confirm (MVP spec §07 checklist). */
export const REQUIRED_CHECKS = [
  'patient',
  'action',
  'dueAt',
  'contact',
  'owner',
  'language',
  'adult',
] as const;
export type ApprovalCheck = (typeof REQUIRED_CHECKS)[number];
