import { describe, expect, it } from 'vitest';
import { AgentProposal, loadConfig } from './index';

const baseEnv = {
  INTAKE_MODEL_ID: 'm-intake',
  COORDINATION_MODEL_ID: 'm-coord',
  VERIFICATION_MODEL_ID: 'm-verify',
  LIVE_MODEL_ID: 'm-live',
};

describe('AgentProposal', () => {
  const valid = {
    caseId: 'case_1',
    approvalRevision: 1,
    role: 'COORDINATION',
    intent: 'REQUEST_BOOKING',
    arguments: { slotId: 'slot_1' },
    sourceRefs: ['src_1'],
    missingFields: [],
  };

  it('accepts a well-formed proposal', () => {
    expect(AgentProposal.parse(valid)).toEqual(valid);
  });

  it('rejects model-supplied tenantId (unknown fields)', () => {
    expect(AgentProposal.safeParse({ ...valid, tenantId: 't_other' }).success).toBe(false);
  });

  it('rejects unknown arguments and intents', () => {
    expect(AgentProposal.safeParse({ ...valid, arguments: { markComplete: true } }).success).toBe(
      false,
    );
    expect(AgentProposal.safeParse({ ...valid, intent: 'MARK_COMPLETED' }).success).toBe(false);
  });
});

describe('loadConfig', () => {
  it('defaults outreach off and safe adapters', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.OUTREACH_ENABLED).toBe(false);
    expect(cfg.BOOKING_ADAPTER).toBe('sandbox');
    expect(cfg.MAX_CONTACT_ATTEMPTS).toBe(2);
    expect(cfg.MAX_CASE_AUDIO_SECONDS).toBe(180);
  });

  it('refuses outreach outside pilot', () => {
    expect(() => loadConfig({ ...baseEnv, APP_ENV: 'demo', OUTREACH_ENABLED: 'true' })).toThrow(
      /only allowed/,
    );
    expect(
      loadConfig({
        ...baseEnv,
        APP_ENV: 'pilot',
        OUTREACH_ENABLED: 'true',
        REQUIRE_STAFF_MFA: 'true',
      }).OUTREACH_ENABLED,
    ).toBe(true);
  });

  it('the pilot cannot run without staff MFA', () => {
    expect(() => loadConfig({ ...baseEnv, APP_ENV: 'pilot' })).toThrow(/REQUIRE_STAFF_MFA/);
  });

  it('requires model IDs to be configured', () => {
    expect(() => loadConfig({})).toThrow(/INTAKE_MODEL_ID/);
  });
});
