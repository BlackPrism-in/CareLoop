import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixtures';

describe('demo fixture', () => {
  it('is valid, synthetic and internally consistent', () => {
    const b = loadFixture();
    expect(b.tenant.simulation).toBe(true);
    expect(b.cases.every((c) => c.workflowState === 'DRAFT')).toBe(true);
    // Covers every staff role so permission tests have a user for each.
    const roles = new Set(b.members.flatMap((m) => m.roleSet));
    expect([...roles].sort()).toEqual(['AUDITOR', 'COORDINATOR', 'OWNER', 'REVIEWER', 'VERIFIER']);
  });
});
