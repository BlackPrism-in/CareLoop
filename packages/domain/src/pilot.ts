import type { PilotArm, PilotConfig } from '@careloop/contracts';
import { sha256 } from './hashing';

/**
 * Pilot group for a newly approved case. Deterministic per case (so a retry
 * gives the same answer) but unpredictable to staff because of the
 * server-side salt. Outside a running pilot there is no group.
 */
export function allocateArm(config: PilotConfig | null, caseId: string): PilotArm | null {
  if (!config) return null;
  if (config.phase === 'BASELINE') return 'BASELINE';
  if (config.phase !== 'INTERVENTION') return null;
  if (!config.concurrentComparison) return 'INTERVENTION';
  const u = parseInt(sha256(`${config.allocationSalt}:${caseId}`).slice(0, 8), 16) / 0x1_0000_0000;
  return u < config.interventionShare ? 'INTERVENTION' : 'USUAL_CARE';
}

/** CareLoop contacts only the intervention group; baseline and usual-care cases follow the lab's normal process. */
export const automatedContactAllowed = (arm: PilotArm | null) =>
  arm === null || arm === 'INTERVENTION';
