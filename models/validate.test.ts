import { describe, expect, it } from 'vitest';
import { IntakeModelOutput, REQUIRED_FIELD_KEYS } from '@careloop/contracts';
import { validateIntake } from './validate';
import { computeDuplicateFingerprint } from './run';

const meta = {
  modelId: 'test-model',
  promptVersion: 'intake-v2',
  latencyMs: 10,
  synthetic: true,
};

function field(
  key: string,
  value: string,
  sourceText: string,
  quote = value,
  start = sourceText.indexOf(quote),
) {
  return { key, value, confidence: 0.9, sourceSpan: { start, end: start + quote.length, quote } };
}

describe('Intake contract and validator', () => {
  it('rejects unknown model output keys', () => {
    expect(IntakeModelOutput.safeParse({ fields: [], warnings: [], book_now: true }).success).toBe(
      false,
    );
  });

  it('repairs a wrong offset only when the quote is unique and computes missing', () => {
    const sourceText = 'Patient: Asha Verma';
    const result = validateIntake({
      sourceText,
      raw: {
        fields: [field('patient_name', 'Asha Verma', sourceText, 'Asha Verma', 0)],
        warnings: [],
      },
      meta,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.fields[0]?.sourceSpan).toEqual({
        start: 9,
        end: 19,
        quote: 'Asha Verma',
      });
      expect(result.proposal.missing).toEqual(
        REQUIRED_FIELD_KEYS.filter((key) => key !== 'patient_name'),
      );
      expect(result.proposal.warnings[0]).toContain('Repaired patient_name');
    }
  });

  it('drops a quote with bad offsets when the quote occurs more than once', () => {
    const sourceText = 'Dr Sen spoke with Dr Sen';
    const result = validateIntake({
      sourceText,
      raw: {
        fields: [field('ordering_clinician', 'Dr Sen', sourceText, 'Dr Sen', 2)],
        warnings: [],
      },
      meta,
    });
    expect(result.ok && result.proposal.fields).toHaveLength(0);
    expect(result.ok && result.proposal.warnings.join(' ')).toContain('ambiguous');
  });

  it('normalizes an action name from its own quote without a fixed test-name list', () => {
    const sourceText = 'Vitamin B12 test ordered by Dr Roy';
    const result = validateIntake({
      sourceText,
      raw: {
        fields: [field('action_name', 'Repeat Vitamin B12', sourceText, 'Vitamin B12 test')],
        warnings: [],
      },
      meta,
    });
    expect(result.ok && result.proposal.fields[0]?.value).toBe('Vitamin B12');
  });

  it('normalizes Indian phones and textual dates', () => {
    const sourceText = 'Phone 98300 12345; complete by 17 Dec 2026';
    const result = validateIntake({
      sourceText,
      raw: {
        fields: [
          field('patient_phone', '98300 12345', sourceText),
          field('due_date', '17 Dec 2026', sourceText),
        ],
        warnings: [],
      },
      meta,
      now: new Date('2026-11-20T00:00:00.000Z'),
    });
    expect(result.ok && result.proposal.fields.map(({ key, value }) => [key, value])).toEqual([
      ['patient_phone', '+919830012345'],
      ['due_date', '2026-12-17'],
    ]);
  });

  it('drops conflicting values for the same key and adds a warning', () => {
    const sourceText = 'Complete by 10/12/2026 or 12/12/2026';
    const result = validateIntake({
      sourceText,
      raw: {
        fields: [
          field('due_date', '10/12/2026', sourceText),
          field('due_date', '12/12/2026', sourceText),
        ],
        warnings: [],
      },
      meta,
    });
    expect(result.ok && result.proposal.fields).toHaveLength(0);
    expect(result.ok && result.proposal.warnings.join(' ')).toContain('Conflicting due_date');
  });

  it('keeps past due dates with a reviewer warning', () => {
    const sourceText = 'Due 01/01/2026';
    const result = validateIntake({
      sourceText,
      raw: { fields: [field('due_date', '01/01/2026', sourceText)], warnings: [] },
      meta,
      now: new Date('2026-11-20T00:00:00.000Z'),
    });
    expect(result.ok && result.proposal.fields[0]?.value).toBe('2026-01-01');
    expect(result.ok && result.proposal.warnings.join(' ')).toContain('past');
  });

  it('drops values that do not appear in their quoted evidence', () => {
    const sourceText = 'Patient: Asha Verma';
    const result = validateIntake({
      sourceText,
      raw: {
        fields: [field('patient_name', 'Kavita Shaw', sourceText, 'Asha Verma')],
        warnings: [],
      },
      meta,
    });
    expect(result.ok && result.proposal.fields).toHaveLength(0);
  });

  it('computes tenant-scoped duplicate fingerprints from source ref and obligation', () => {
    const fields = [
      {
        key: 'source_ref',
        value: 'SDL-0042',
        confidence: 1,
        sourceSpan: { start: 0, end: 8, quote: 'SDL-0042' },
      },
      {
        key: 'action_type',
        value: 'ordered_test',
        confidence: 1,
        sourceSpan: { start: 0, end: 8, quote: 'ordered' },
      },
      {
        key: 'action_name',
        value: 'CBC',
        confidence: 1,
        sourceSpan: { start: 0, end: 8, quote: 'CBC test' },
      },
      {
        key: 'due_date',
        value: '2026-11-30',
        confidence: 1,
        sourceSpan: { start: 0, end: 8, quote: '30/11/2026' },
      },
    ] as const;
    const first = computeDuplicateFingerprint({ tenantId: 'tenant-a', fields: [...fields] });
    const duplicate = computeDuplicateFingerprint({ tenantId: 'tenant-a', fields: [...fields] });
    const otherTenant = computeDuplicateFingerprint({ tenantId: 'tenant-b', fields: [...fields] });
    expect(first).toBe(duplicate);
    expect(first).not.toBe(otherTenant);
  });
});
