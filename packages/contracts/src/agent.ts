import { z } from 'zod';

export const AgentRole = z.enum(['INTAKE', 'CONVERSATION', 'COORDINATION', 'VERIFICATION']);
export type AgentRole = z.infer<typeof AgentRole>;

export const ProposalIntent = z.enum([
  'REQUEST_BOOKING',
  'REQUEST_CALLBACK',
  'CREATE_HANDOFF',
  'NO_ACTION',
]);
export type ProposalIntent = z.infer<typeof ProposalIntent>;

/**
 * Structured output contract (MVP spec §10). Strict: unknown fields are rejected.
 * tenantId, actorId and permissions are NEVER taken from the model — they come
 * from server context. A proposal is not authorization; only domain commands
 * change persisted state.
 */
export const AgentProposal = z.strictObject({
  caseId: z.string().min(1),
  approvalRevision: z.number().int().positive(),
  role: AgentRole,
  intent: ProposalIntent,
  arguments: z.strictObject({
    slotId: z.string().min(1).optional(),
    requestedWindow: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }).optional(),
    reasonCode: z.string().min(1).optional(),
  }),
  sourceRefs: z.array(z.string().min(1)),
  missingFields: z.array(z.string().min(1)),
  /** Optional conversation-only facts; captured by the patient, never decisions. */
  capturedPreferences: z.array(z.string().min(1)).optional(),
  capturedBarriers: z.array(z.string().min(1)).optional(),
});
export type AgentProposal = z.infer<typeof AgentProposal>;

/** Execution budget per coordination turn (MVP spec §10). */
export const COORDINATION_LIMITS = { maxToolOperations: 3, maxReplans: 2 } as const;
