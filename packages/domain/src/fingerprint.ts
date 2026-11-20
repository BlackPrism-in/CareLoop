import { createHash } from 'node:crypto';

/**
 * Duplicate-detection key: tenant + source authority/reference + obligation key
 * (MVP spec §13). Deliberately excludes patient name so patients are never
 * merged by name.
 */
export function caseFingerprint(input: {
  tenantId: string;
  sourceAuthority: string;
  sourceReference: string;
  obligationKey: string;
}): string {
  const canonical = [
    input.tenantId,
    input.sourceAuthority,
    input.sourceReference,
    input.obligationKey,
  ]
    .map((s) => s.trim().toLowerCase())
    .join('\u001f');
  return createHash('sha256').update(canonical).digest('hex');
}
