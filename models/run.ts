import { createHash, randomUUID } from 'node:crypto';
import { IntakeInput, IntakeProposal, parseIntakeInput } from './validate';
import { IntakeModel } from './model';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserContent } from './prompt';
import { validateIntake } from './validate';

export type IntakeRunResult =
  | { status: 'proposal'; proposal: IntakeProposal; attempts: number }
  | { status: 'manual_entry'; reason: string; attempts: number }; // UI shows a banner; case is never stuck

const MAX_ATTEMPTS = 2; // first try + one retry

export function computeDuplicateFingerprint(args: {
  tenantId: string;
  fields: IntakeProposal['fields'];
}): string | null {
  const value = (key: string) =>
    args.fields
      .find((field) => field.key === key)
      ?.value.trim()
      .toLocaleLowerCase();
  const sourceRef = value('source_ref');
  const actionType = value('action_type');
  const actionName = value('action_name');
  const dueDate = value('due_date');
  if (!sourceRef || !actionType || !actionName || !dueDate) return null;
  const obligationKey = [actionType, actionName, dueDate].join(':');
  return createHash('sha256')
    .update([args.tenantId, sourceRef, obligationKey].join('|'))
    .digest('hex');
}

// Pure w.r.t. domain state: returns a proposal. The worker wraps this in a domain
// command (expectedVersion + idempotency key) that saves it to the draft.
export async function runIntake(
  rawInput: unknown,
  deps: { model: IntakeModel; timeoutMs?: number; synthetic: boolean; now?: () => Date },
): Promise<IntakeRunResult> {
  const input = parseIntakeInput(rawInput);
  let reason = 'unknown';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 30_000);
    try {
      const out = await deps.model.call({
        system: SYSTEM_PROMPT,
        user: buildUserContent({
          sourceText: input.sourceText,
          nonce: randomUUID(),
          sourceAuthority: input.sourceAuthority,
          languageHint: input.languageHint,
        }),
        signal: ctrl.signal,
      });
      const v = validateIntake({
        sourceText: input.sourceText,
        raw: out.raw,
        now: deps.now?.(),
        meta: {
          modelId: out.modelId,
          promptVersion: PROMPT_VERSION,
          latencyMs: out.latencyMs,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          synthetic: deps.synthetic,
        },
      });
      if (v.ok) {
        return {
          status: 'proposal',
          proposal: {
            ...v.proposal,
            duplicateFingerprint: computeDuplicateFingerprint({
              tenantId: input.tenantId,
              fields: v.proposal.fields,
            }),
          },
          attempts: attempt,
        };
      }
      reason = `validation: ${v.reason}`;
    } catch (e) {
      reason = `model_error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 'manual_entry', reason, attempts: MAX_ATTEMPTS };
}
