import { describe, expect, it } from 'vitest';
import type { Consent, Patient } from '@careloop/contracts';
import { caseFingerprint } from './fingerprint';
import { parseCsv, validateCsv, type CsvContext } from './csv-intake';

const p = (id: string, ref: string, adult = true) =>
  ({
    patientId: id,
    externalRef: ref,
    language: 'hi-IN',
    ageEligibility: adult ? 'ADULT_CONFIRMED' : 'UNKNOWN',
  }) as Patient;
const ctx = (): CsvContext => ({
  tenantId: 't',
  now: new Date('2026-11-21T00:00:00Z'),
  defaultOwnerId: 'u1',
  activeOwnerIds: new Set(['u1', 'u2']),
  patientsByRef: new Map([
    ['R1', p('p1', 'R1')],
    ['R2', p('p2', 'R2', false)],
    ['R3', p('p3', 'R3')],
  ]),
  activeConsentByPatient: new Map([
    ['p1', { consentId: 'c1' } as Consent],
    ['p2', { consentId: 'c2' } as Consent],
  ]),
  existingCaseByFingerprint: new Map([
    [
      caseFingerprint({
        tenantId: 't',
        sourceAuthority: 'Clinic',
        sourceReference: 'OLD-1',
        obligationKey: 'CONSULTATION',
      }),
      'CL-9',
    ],
  ]),
});
const HEAD = 'patient_ref,action_type,action_text,due_date,source_authority,reference\n';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines inside fields', () => {
    expect(parseCsv('a,b\r\n"x, ""y""","line1\nline2"\n')).toEqual([
      ['a', 'b'],
      ['x, "y"', 'line1\nline2'],
    ]);
  });
});

describe('validateCsv', () => {
  it('validates every row and reports all problems at once', () => {
    const r = validateCsv(
      HEAD +
        'R1,consultation,Book consultation,2026-11-28,Clinic,ORD-1\n' +
        'R9,CONSULTATION,x,2026-11-28,Clinic,ORD-2\n' +
        'R3,SURGERY,x,2026-11-01,Clinic,ORD-3\n' +
        'R1,CONSULTATION,again,2026-11-28,Clinic,ORD-1\n' +
        'R1,CONSULTATION,old,2026-11-28,Clinic,OLD-1\n' +
        'R2,ORDERED_TEST,collect sample,2026-11-29,Lab,L-5\n',
      ctx(),
    );
    expect(r.headerErrors).toEqual([]);
    expect(r.rows.map((x) => x.status)).toEqual([
      'OK',
      'ERROR',
      'ERROR',
      'ERROR',
      'DUPLICATE',
      'OK',
    ]);
    expect(r.rows[1]!.errors).toContain('Unknown patient reference');
    expect(r.rows[2]!.errors).toEqual(
      expect.arrayContaining([
        'action_type must be CONSULTATION or ORDERED_TEST',
        'due_date has passed',
        'No active contact permission for this patient',
      ]),
    );
    expect(r.rows[3]!.errors).toEqual(['Same order and action as line 2']);
    expect(r.rows[4]!.existingCaseId).toBe('CL-9');
    expect(r.rows[5]!.warnings[0]).toMatch(/Adult eligibility/);
  });
  it('rejects bad headers, empty files and oversized imports', () => {
    expect(validateCsv('patient_ref,foo\n', ctx()).headerErrors).toEqual(
      expect.arrayContaining(['Missing column: action_type', 'Unknown column: foo']),
    );
    expect(validateCsv(HEAD, ctx()).headerErrors).toEqual(['No rows']);
    expect(
      validateCsv(HEAD + 'R1,CONSULTATION,x,2026-11-28,C,R\n'.repeat(101), ctx()).headerErrors[0],
    ).toMatch(/At most 100/);
  });
});
