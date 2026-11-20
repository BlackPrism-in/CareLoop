import type { ActionType, Consent, Patient, SupportedLanguage } from '@careloop/contracts';
import { caseFingerprint } from './fingerprint';
import { sourceIdFor } from './sources';

/**
 * CSV bulk intake (MVP spec §01 P1): preview → validate every row → commit
 * only when no row has errors. Pure functions; the API supplies lookups.
 *
 * Columns (header row required, any order):
 *   patient_ref, action_type, action_text, due_date (YYYY-MM-DD),
 *   source_authority, reference, [owner_id], [language]
 */
export const CSV_COLUMNS = [
  'patient_ref',
  'action_type',
  'action_text',
  'due_date',
  'source_authority',
  'reference',
  'owner_id',
  'language',
] as const;
const REQUIRED = [
  'patient_ref',
  'action_type',
  'action_text',
  'due_date',
  'source_authority',
  'reference',
] as const;
export const CSV_MAX_ROWS = 100;
export const CSV_MAX_BYTES = 64_000;

/** RFC 4180 parser: quoted fields, escaped quotes, CRLF/LF, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export interface CsvRowResult {
  line: number;
  status: 'OK' | 'ERROR' | 'DUPLICATE';
  errors: string[];
  warnings: string[];
  existingCaseId?: string;
  input?: {
    patientId: string;
    consentId: string;
    actionType: ActionType;
    actionText: string;
    dueAt: string;
    ownerId: string;
    language: SupportedLanguage;
    source: { sourceAuthority: string; reference: string };
    sourceId: string;
    fingerprint: string;
  };
}

export interface CsvContext {
  tenantId: string;
  now: Date;
  defaultOwnerId: string;
  activeOwnerIds: Set<string>;
  patientsByRef: Map<string, Patient>;
  activeConsentByPatient: Map<string, Consent>;
  /** Defaults to Hindi and English. */
  enabledLanguages?: readonly SupportedLanguage[];
  existingCaseByFingerprint: Map<string, string>;
}

/** Validates every row; never stops at the first error, so staff see all problems at once. */
export function validateCsv(
  text: string,
  ctx: CsvContext,
): { headerErrors: string[]; rows: CsvRowResult[] } {
  if (text.length > CSV_MAX_BYTES)
    return { headerErrors: [`File is larger than ${CSV_MAX_BYTES / 1000} KB`], rows: [] };
  const all = parseCsv(text);
  const header = (all[0] ?? []).map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  const unknown = header.filter((h) => !(CSV_COLUMNS as readonly string[]).includes(h));
  const headerErrors = [
    ...missing.map((c) => `Missing column: ${c}`),
    ...unknown.map((c) => `Unknown column: ${c}`),
  ];
  if (headerErrors.length) return { headerErrors, rows: [] };
  const body = all.slice(1);
  if (body.length === 0) return { headerErrors: ['No rows'], rows: [] };
  if (body.length > CSV_MAX_ROWS)
    return {
      headerErrors: [`At most ${CSV_MAX_ROWS} rows per import (found ${body.length})`],
      rows: [],
    };

  const seen = new Map<string, number>();
  const rows = body.map((cells, i): CsvRowResult => {
    const line = i + 2;
    const get = (c: (typeof CSV_COLUMNS)[number]) => (cells[header.indexOf(c)] ?? '').trim();
    const errors: string[] = [];
    const warnings: string[] = [];
    const patient = ctx.patientsByRef.get(get('patient_ref'));
    if (!patient) errors.push('Unknown patient reference');
    const actionType = get('action_type').toUpperCase();
    if (actionType !== 'CONSULTATION' && actionType !== 'ORDERED_TEST')
      errors.push('action_type must be CONSULTATION or ORDERED_TEST');
    const actionText = get('action_text');
    if (!actionText || actionText.length > 500)
      errors.push('action_text is required (max 500 characters)');
    const due = get('due_date');
    const dueAt = /^\d{4}-\d{2}-\d{2}$/.test(due) ? new Date(`${due}T23:59:00+05:30`) : null;
    if (!dueAt || Number.isNaN(dueAt.getTime())) errors.push('due_date must be YYYY-MM-DD');
    else if (dueAt <= ctx.now) errors.push('due_date has passed');
    const sourceAuthority = get('source_authority');
    const reference = get('reference');
    if (!sourceAuthority || sourceAuthority.length > 120)
      errors.push('source_authority is required');
    if (!reference || reference.length > 120) errors.push('reference is required');
    const ownerId = get('owner_id') || ctx.defaultOwnerId;
    if (!ctx.activeOwnerIds.has(ownerId)) errors.push('owner_id is not an active staff member');
    const lang = (get('language') || patient?.language || '') as SupportedLanguage;
    if (!(ctx.enabledLanguages ?? ['hi-IN', 'en-IN']).includes(lang))
      errors.push(
        `language must be one of ${(ctx.enabledLanguages ?? ['hi-IN', 'en-IN']).join(', ')}`,
      );
    const consent = patient ? ctx.activeConsentByPatient.get(patient.patientId) : undefined;
    if (patient && !consent) errors.push('No active contact permission for this patient');
    if (patient && patient.ageEligibility !== 'ADULT_CONFIRMED')
      warnings.push('Adult eligibility not confirmed — a reviewer will not be able to approve');
    if (errors.length) return { line, status: 'ERROR', errors, warnings };

    const fingerprint = caseFingerprint({
      tenantId: ctx.tenantId,
      sourceAuthority,
      sourceReference: reference,
      obligationKey: actionType,
    });
    const dupLine = seen.get(fingerprint);
    if (dupLine)
      return {
        line,
        status: 'ERROR',
        errors: [`Same order and action as line ${dupLine}`],
        warnings,
      };
    seen.set(fingerprint, line);
    const existing = ctx.existingCaseByFingerprint.get(fingerprint);
    const input = {
      patientId: patient!.patientId,
      consentId: consent!.consentId,
      actionType: actionType as ActionType,
      actionText,
      dueAt: dueAt!.toISOString(),
      ownerId,
      language: lang,
      source: { sourceAuthority, reference },
      sourceId: sourceIdFor({ sourceAuthority, reference }),
      fingerprint,
    };
    if (existing)
      return {
        line,
        status: 'DUPLICATE',
        errors: [],
        warnings: [`Already a case: ${existing}`],
        existingCaseId: existing,
        input,
      };
    return { line, status: 'OK', errors: [], warnings, input };
  });
  return { headerErrors: [], rows };
}
