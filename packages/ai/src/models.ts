import type { AgentRole, AppConfig } from '@careloop/contracts';

/**
 * Model role → configured model ID (Blueprint p.7, MVP spec §10). IDs come
 * from environment configuration and must be verified against the selected
 * API surface before use (`pnpm check:models`).
 */
export function modelFor(role: AgentRole, cfg: AppConfig): string {
  switch (role) {
    case 'INTAKE':
      return cfg.INTAKE_MODEL_ID;
    case 'CONVERSATION':
      return cfg.LIVE_MODEL_ID;
    case 'COORDINATION':
      return cfg.COORDINATION_MODEL_ID;
    case 'VERIFICATION':
      return cfg.VERIFICATION_MODEL_ID;
  }
}

export function configuredModels(cfg: AppConfig): Record<AgentRole, string> {
  return {
    INTAKE: modelFor('INTAKE', cfg),
    CONVERSATION: modelFor('CONVERSATION', cfg),
    COORDINATION: modelFor('COORDINATION', cfg),
    VERIFICATION: modelFor('VERIFICATION', cfg),
  };
}
