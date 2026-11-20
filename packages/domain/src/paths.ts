/**
 * Tenant-scoped Firestore paths (MVP spec §13). Every repository query must be
 * built from these helpers with a tenantId derived from server-side membership
 * — never from a client payload. Server SDKs bypass Security Rules, so this is
 * the isolation boundary.
 */
const SAFE = /^[A-Za-z0-9_-]+$/;

function seg(name: string, value: string): string {
  if (!SAFE.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

export const TENANT_COLLECTIONS = [
  'members',
  'sites',
  'patients',
  'consents',
  'cases',
  'sources',
  'approvals',
  'interactions',
  'slots',
  'bookings',
  'evidence',
  'handoffs',
  'operations',
  'inbox',
  'outbox',
  'jobs',
  'failed_jobs',
  'case_fingerprints',
] as const;
export type TenantCollection = (typeof TENANT_COLLECTIONS)[number];

export function tenantDoc(tenantId: string): string {
  return `tenants/${seg('tenantId', tenantId)}`;
}

export function tenantCollection(tenantId: string, collection: TenantCollection): string {
  return `${tenantDoc(tenantId)}/${collection}`;
}

export function tenantRecord(
  tenantId: string,
  collection: TenantCollection,
  docId: string,
): string {
  return `${tenantCollection(tenantId, collection)}/${seg('docId', docId)}`;
}

export function caseEvents(tenantId: string, caseId: string): string {
  return `${tenantRecord(tenantId, 'cases', caseId)}/events`;
}
