import { describe, expect, it } from 'vitest';
import { loadConfig } from '@careloop/contracts';
import { configuredModels } from './index';

describe('configuredModels', () => {
  it('maps each agent role to its configured model', () => {
    const cfg = loadConfig({
      INTAKE_MODEL_ID: 'a',
      COORDINATION_MODEL_ID: 'b',
      VERIFICATION_MODEL_ID: 'c',
      LIVE_MODEL_ID: 'd',
    });
    expect(configuredModels(cfg)).toEqual({
      INTAKE: 'a',
      CONVERSATION: 'd',
      COORDINATION: 'b',
      VERIFICATION: 'c',
    });
  });
});
