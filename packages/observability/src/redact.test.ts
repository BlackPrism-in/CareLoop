import { describe, expect, it } from 'vitest';
import { redact } from './index';

describe('redact', () => {
  it('removes sensitive keys at any depth and keeps ids', () => {
    expect(
      redact({
        caseId: 'c1',
        correlationId: 'x',
        patient: { phone: '9', displayName: 'A' },
        items: [{ token: 't' }],
      }),
    ).toEqual({
      caseId: 'c1',
      correlationId: 'x',
      patient: { phone: '[redacted]', displayName: '[redacted]' },
      items: [{ token: '[redacted]' }],
    });
  });
});
