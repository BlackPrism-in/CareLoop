import {
  AgentProposal,
  COORDINATION_BUDGET,
  CoordinationContext,
  CoordinationToolCall,
  CoordinationStepProposal,
  type CoordinationContext as Context,
  type CoordinationStepProposal as StepProposal,
  type HandoffReasonCode,
} from '@careloop/contracts';
import type { CoordinationActor, CoordinationGateway } from './gateway';
import type { CoordinationModel, CoordinationModelResult } from './model';

export type CoordinationRunResult =
  | {
      status: 'proposal';
      proposal: AgentProposal;
      toolOperations: number;
      replans: number;
      modelCalls: number;
      rationale: string;
      meta: { modelId: string; promptVersion: string; latencyMs: number; inputTokens?: number; outputTokens?: number };
    }
  | {
      status: 'manual_entry';
      reason: string;
      toolOperations: number;
      replans: number;
      modelCalls: number;
    };

export interface RunCoordinationArgs {
  context: Context;
  actor: CoordinationActor;
  model: CoordinationModel;
  gateway: CoordinationGateway;
  timeoutMs?: number;
  now?: () => number;
}

/** Bounded propose → gate → execute → replan loop. */
export async function runCoordination(args: RunCoordinationArgs): Promise<CoordinationRunResult> {
  let context = CoordinationContext.parse(args.context);
  if (context.caseId !== args.actor.caseId || context.approvalRevision !== args.actor.approvalRevision)
    return manual('SERVER_CONTEXT_MISMATCH');
  if (context.optedOut || !context.consentActive) {
    return proposalResult(args, context, { type: 'finish', outcome: 'OPT_OUT_STOPPED', rationale: 'Consent is inactive; automation stopped.' }, 0, 0, 0, undefined);
  }

  const start = (args.now ?? Date.now)();
  const deadline = start + Math.min(args.timeoutMs ?? COORDINATION_BUDGET.maxWallTimeMs, COORDINATION_BUDGET.maxWallTimeMs);
  const observations: Array<{ toolCall: unknown; result: unknown }> = [];
  let toolOperations = 0;
  let replans = 0;
  let modelCalls = 0;
  let totalTokens = 0;
  let lastModel: CoordinationModelResult | undefined;
  let invalidRetries = 0;

  const fallbackHandoff = async (reasonCode: HandoffReasonCode, why: string): Promise<CoordinationRunResult> => {
    if (context.optedOut || !context.consentActive) {
      const stopped: StepProposal = { type: 'finish', outcome: 'OPT_OUT_STOPPED', rationale: 'Consent is inactive; automation stopped.' };
      return proposalResult(args, context, stopped, toolOperations, replans, modelCalls, lastModel);
    }
    const call = CoordinationToolCall.parse({
      name: 'create_handoff',
      arguments: { reasonCode, summary: 'Coordination could not safely complete the requested scheduling step.' },
    });
    const result = await args.gateway.execute(args.actor, call);
    if (!result.ok) return manual(`HANDOFF_FAILED:${result.code}`, toolOperations, replans, modelCalls);
    toolOperations++;
    const finish: StepProposal = {
      type: 'finish',
      outcome: 'HANDOFF_CREATED',
      rationale: why.slice(0, 280),
    };
    return proposalResult(args, context, finish, toolOperations, replans, modelCalls, lastModel, call);
  };

  for (let cycle = 0; cycle <= COORDINATION_BUDGET.maxReplans; cycle++) {
    if ((args.now ?? Date.now)() >= deadline) return fallbackHandoff('BUDGET_EXHAUSTED', 'Coordination time budget exhausted; handed off to staff.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - (args.now ?? Date.now)()));
    let raw: unknown;
    try {
      modelCalls++;
      lastModel = await args.model.propose({
        context: {
          ...context,
          remainingToolOperations: Math.max(0, COORDINATION_BUDGET.maxToolOperations - toolOperations),
          remainingReplans: Math.max(0, COORDINATION_BUDGET.maxReplans - replans),
        },
        observations,
        signal: controller.signal,
      });
      totalTokens += (lastModel.inputTokens ?? 0) + (lastModel.outputTokens ?? 0);
      raw = lastModel.raw;
    } catch (error) {
      clearTimeout(timer);
      if (cycle < COORDINATION_BUDGET.maxReplans) {
        replans++;
        observations.push({ toolCall: { name: 'model_retry' }, result: { ok: false, code: 'MODEL_ERROR' } });
        continue;
      }
      return fallbackHandoff('OTHER', `Model failed; staff handoff created. ${message(error)}`);
    }
    clearTimeout(timer);

    if (totalTokens > COORDINATION_BUDGET.maxTotalTokens)
      return fallbackHandoff('BUDGET_EXHAUSTED', 'Token budget exhausted; handed off to staff.');

    const parsed = CoordinationStepProposal.safeParse(raw);
    if (!parsed.success) {
      if (invalidRetries++ < 1 && cycle < COORDINATION_BUDGET.maxReplans) {
        replans++;
        observations.push({ toolCall: { name: 'schema_retry' }, result: { ok: false, code: 'INVALID_PROPOSAL' } });
        continue;
      }
      return fallbackHandoff('OTHER', 'Coordination response was invalid; handed off to staff.');
    }
    if (parsed.data.type === 'finish') {
      if (parsed.data.outcome === 'OPT_OUT_STOPPED' && !context.optedOut)
        return fallbackHandoff('OTHER', 'Invalid opt-out finish; handed off to staff.');
      if (parsed.data.outcome === 'HANDOFF_CREATED')
        return fallbackHandoff('OTHER', 'The model cannot claim a handoff it did not create.');
      if (parsed.data.outcome === 'BOOKING_REQUESTED' || parsed.data.outcome === 'CALLBACK_REQUESTED')
        return fallbackHandoff('OTHER', 'The model cannot claim an operation that was not executed.');
      if (parsed.data.outcome === 'NO_ACTION' && context.workflowState === 'AWAITING_BOOKING' && context.bookingState === 'NONE')
        return fallbackHandoff('OTHER', 'No safe action was identified; handed off to staff.');
      return proposalResult(args, context, parsed.data, toolOperations, replans, modelCalls, lastModel);
    }

    const toolCall = parsed.data.toolCall;
    const result = await args.gateway.execute(args.actor, toolCall);
    if (result.ok) toolOperations++;
    observations.push({ toolCall, result });

    if (!result.ok) {
      if (result.code === 'OPT_OUT_STOPPED' || result.code === 'CONSENT_INACTIVE') {
        const stopped: StepProposal = { type: 'finish', outcome: 'OPT_OUT_STOPPED', rationale: 'Consent changed during coordination; stopped all actions.' };
        return proposalResult(args, context, stopped, toolOperations, replans, modelCalls, lastModel);
      }
      if (result.code === 'BOOKING_OUTCOME_UNKNOWN' || result.code === 'BOOKING_UNKNOWN')
        return fallbackHandoff('BOOKING_UNKNOWN', 'Booking outcome is unknown; no retry was attempted.');
      if (result.code === 'CALLBACK_OUTCOME_UNKNOWN')
        return fallbackHandoff('OTHER', 'Callback request outcome is unknown; staff must reconcile it.');
      if (result.code === 'HANDOFF_OUTCOME_UNKNOWN')
        return manual('HANDOFF_OUTCOME_UNKNOWN: reconcile the case task before retrying.', toolOperations, replans, modelCalls);
      if (result.code === 'IDENTITY_MISMATCH')
        return fallbackHandoff('IDENTITY_MISMATCH', 'Identity could not be confirmed; handed off to staff.');
      if (result.code === 'CONTACT_BUDGET_EXHAUSTED' || result.code === 'TOOL_BUDGET_EXHAUSTED' || result.code === 'REPLANNING_BUDGET_EXHAUSTED')
        return fallbackHandoff('BUDGET_EXHAUSTED', 'A coordination budget was exhausted; handed off to staff.');
      if (result.code === 'NO_SLOTS')
        return fallbackHandoff('NO_SLOTS', 'No suitable slots are available; handed off to staff.');
    } else if (result.tool === 'request_booking') {
      return proposalResult(args, context, { type: 'finish', outcome: 'BOOKING_REQUESTED', rationale: parsed.data.rationale }, toolOperations, replans, modelCalls, lastModel, toolCall);
    } else if (result.tool === 'request_callback') {
      return proposalResult(args, context, { type: 'finish', outcome: 'CALLBACK_REQUESTED', rationale: parsed.data.rationale }, toolOperations, replans, modelCalls, lastModel, toolCall);
    } else if (result.tool === 'create_handoff') {
      return proposalResult(args, context, { type: 'finish', outcome: 'HANDOFF_CREATED', rationale: parsed.data.rationale }, toolOperations, replans, modelCalls, lastModel, toolCall);
    } else {
      context = CoordinationContext.parse({
        ...context,
        offeredSlots: result.slots,
        remainingToolOperations: Math.max(0, COORDINATION_BUDGET.maxToolOperations - toolOperations),
        remainingReplans: Math.max(0, COORDINATION_BUDGET.maxReplans - replans),
      });
      if (result.slots.length === 0)
        return fallbackHandoff('NO_SLOTS', 'No suitable slots are available; handed off to staff.');
    }

    if (cycle === COORDINATION_BUDGET.maxReplans)
      return fallbackHandoff('BUDGET_EXHAUSTED', 'Replanning budget exhausted; handed off to staff.');
    replans++;
  }

  return fallbackHandoff('OTHER', 'Coordination ended without a safe outcome; handed off to staff.');
}

function proposalResult(
  args: RunCoordinationArgs,
  context: Context,
  finish: StepProposal,
  toolOperations: number,
  replans: number,
  modelCalls: number,
  model: CoordinationModelResult | undefined,
  executedCall?: Extract<StepProposal, { type: 'tool_call' }>['toolCall'],
): CoordinationRunResult {
  if (finish.type !== 'finish') return manual('INVALID_FINISH', toolOperations, replans, modelCalls);
  let intent: 'REQUEST_BOOKING' | 'REQUEST_CALLBACK' | 'CREATE_HANDOFF' | 'NO_ACTION' = 'NO_ACTION';
  const proposalArgs: { slotId?: string; requestedWindow?: { from: string; to: string }; reasonCode?: string } = {};
  if (finish.outcome === 'BOOKING_REQUESTED' && executedCall?.name === 'request_booking') {
    intent = 'REQUEST_BOOKING';
    proposalArgs.slotId = executedCall.arguments.slotId;
  } else if (finish.outcome === 'CALLBACK_REQUESTED' && executedCall?.name === 'request_callback') {
    intent = 'REQUEST_CALLBACK';
    if (executedCall.arguments.from && executedCall.arguments.to)
      proposalArgs.requestedWindow = { from: executedCall.arguments.from, to: executedCall.arguments.to };
  } else if (finish.outcome === 'HANDOFF_CREATED' && executedCall?.name === 'create_handoff') {
    intent = 'CREATE_HANDOFF';
    proposalArgs.reasonCode = executedCall.arguments.reasonCode;
  }
  const parsed = AgentProposal.safeParse({
    caseId: context.caseId,
    approvalRevision: context.approvalRevision,
    role: 'COORDINATION',
    intent,
    arguments: proposalArgs,
    sourceRefs: [],
    missingFields: [],
  });
  if (!parsed.success) return manual('FINAL_PROPOSAL_INVALID', toolOperations, replans, modelCalls);
  return {
    status: 'proposal',
    proposal: parsed.data,
    toolOperations,
    replans,
    modelCalls,
    rationale: finish.rationale,
    meta: {
      modelId: model?.modelId ?? 'none',
      promptVersion: model?.promptVersion ?? 'coordination-v1',
      latencyMs: model?.latencyMs ?? 0,
      ...(model?.inputTokens === undefined ? {} : { inputTokens: model.inputTokens }),
      ...(model?.outputTokens === undefined ? {} : { outputTokens: model.outputTokens }),
    },
  };
}

function manual(reason: string, toolOperations = 0, replans = 0, modelCalls = 0): CoordinationRunResult {
  return { status: 'manual_entry', reason, toolOperations, replans, modelCalls };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 140) : 'unknown model error';
}
