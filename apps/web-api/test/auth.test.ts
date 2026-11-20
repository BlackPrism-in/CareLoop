import { describe, expect, it } from 'vitest';
import { hasRequiredFactor } from '@/server/auth';

describe('staff MFA enforcement', () => {
  it('is not required outside the pilot', () => {
    expect(hasRequiredFactor(false, undefined)).toBe(true);
  });
  it('requires a second-factor sign-in when enforced', () => {
    expect(hasRequiredFactor(true, undefined)).toBe(false);
    expect(hasRequiredFactor(true, 'password')).toBe(false);
    expect(hasRequiredFactor(true, 'totp')).toBe(true);
  });
});
