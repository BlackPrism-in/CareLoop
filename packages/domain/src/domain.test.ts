import { describe, expect, it } from 'vitest';
import { caseFingerprint, caseEvents, tenantRecord } from './index';

describe('tenant paths', () => {
  it('builds scoped paths', () => {
    expect(tenantRecord('t1', 'cases', 'c1')).toBe('tenants/t1/cases/c1');
    expect(caseEvents('t1', 'c1')).toBe('tenants/t1/cases/c1/events');
  });
  it('rejects path traversal and separators', () => {
    expect(() => tenantRecord('t1/../t2', 'cases', 'c1')).toThrow();
    expect(() => tenantRecord('t1', 'cases', '')).toThrow();
  });
});

describe('caseFingerprint', () => {
  const base = {
    tenantId: 't1',
    sourceAuthority: 'clinic',
    sourceReference: 'ORD-1',
    obligationKey: 'CONSULTATION',
  };
  it('is stable and case-insensitive', () => {
    expect(caseFingerprint(base)).toBe(caseFingerprint({ ...base, sourceReference: ' ord-1 ' }));
  });
  it('differs per tenant and per obligation', () => {
    expect(caseFingerprint(base)).not.toBe(caseFingerprint({ ...base, tenantId: 't2' }));
    expect(caseFingerprint(base)).not.toBe(
      caseFingerprint({ ...base, obligationKey: 'ORDERED_TEST' }),
    );
  });
});
