import { z } from 'zod';
import { callWithRetry, type JsonModel } from './model-client';
import { VERIFICATION_PROMPT } from './prompts';

const FIELDS = ['patientRef', 'actionType', 'occurredAt', 'provider', 'bookingRef'] as const;

const RAW = z.object({
  matched: z.array(z.enum(FIELDS)),
  conflicts: z.array(z.object({ field: z.enum(FIELDS), detail: z.string().max(300) })),
  summary: z.string().max(400),
});

export interface VerificationReview {
  matched: (typeof FIELDS)[number][];
  conflicts: { field: (typeof FIELDS)[number]; detail: string }[];
  summary: string;
  /** Always a recommendation: deterministic matching or a named verifier decides. */
  recommendation: 'LOOKS_CONSISTENT' | 'NEEDS_HUMAN_REVIEW';
  promptVersion: string;
}

/**
 * Verification agent (Flash, read-only): evidence excerpt + case references →
 * matched fields, conflicts and a neutral summary for the verifier. It cannot
 * complete a case; Phase 5 shows this next to the deterministic match result.
 */
export async function reviewEvidence(
  model: JsonModel,
  modelId: string,
  input: { excerpt: string; caseRefs: Record<(typeof FIELDS)[number], string | null> },
): Promise<VerificationReview> {
  const res = await callWithRetry(model, {
    model: modelId,
    system: VERIFICATION_PROMPT.system,
    user: `CASE_REFERENCES:\n${JSON.stringify(input.caseRefs)}\n\n<evidence>\n${input.excerpt.slice(0, 4000).replaceAll('</evidence>', '</ evidence>')}\n</evidence>`,
    schema: {
      type: 'object',
      properties: {
        matched: { type: 'array', items: { type: 'string', enum: [...FIELDS] } },
        conflicts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', enum: [...FIELDS] },
              detail: { type: 'string' },
            },
            required: ['field', 'detail'],
          },
        },
        summary: { type: 'string' },
      },
      required: ['matched', 'conflicts', 'summary'],
    },
    timeoutMs: 10_000,
  });
  const parsed = RAW.safeParse(res.data);
  if (!parsed.success) {
    return {
      matched: [],
      conflicts: [],
      summary: 'The automated review could not be read. Review the evidence manually.',
      recommendation: 'NEEDS_HUMAN_REVIEW',
      promptVersion: VERIFICATION_PROMPT.version,
    };
  }
  const { matched, conflicts, summary } = parsed.data;
  return {
    matched,
    conflicts,
    summary,
    recommendation:
      conflicts.length === 0 && matched.includes('patientRef') && matched.includes('occurredAt')
        ? 'LOOKS_CONSISTENT'
        : 'NEEDS_HUMAN_REVIEW',
    promptVersion: VERIFICATION_PROMPT.version,
  };
}
