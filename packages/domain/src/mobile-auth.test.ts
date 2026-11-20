import { describe, expect, it } from 'vitest';
import { normalisePhone } from './mobile-auth';

describe('normalisePhone', () => {
  it('accepts common Indian formats', () => {
    expect(normalisePhone('98000 00101')).toBe('+919800000101');
    expect(normalisePhone('+91 98000-00101')).toBe('+919800000101');
    expect(normalisePhone('0091 9800000101')).toBe('+919800000101');
  });
  it('rejects junk', () => {
    expect(normalisePhone('12')).toBeNull();
    expect(normalisePhone('call me')).toBeNull();
  });
});
