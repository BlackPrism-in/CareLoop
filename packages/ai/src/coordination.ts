import { AgentProposal, COORDINATION_LIMITS } from '@careloop/contracts';
import { callWithRetry, ModelError, type JsonModel } from './model-client';
import { COORDINATION_PROMPT } from './prompts';

export interface OfferedSlot {
  slotId: string;
  startsAt: string;
  /** Human-readable local time, e.g. "Sat 21 Nov, 4:30 pm". */
  label: string;
  location: string;
}

export interface CoordinationResult {
  proposal: AgentProposal;
  /** Slots to offer, best match first; always a subset of the adapter's list. */
  ranked: OfferedSlot[];
  source: 'model' | 'fallback';
  rejectedReason: string | null;
  promptVersion: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['REQUEST_BOOKING', 'CREATE_HANDOFF', 'NO_ACTION'] },
    slotId: { type: 'string' },
    reasonCode: { type: 'string' },
  },
  required: ['intent'],
};

/** Deterministic preference matcher used when the model is unavailable or rejected. */
export function rankByPreference(
  slots: OfferedSlot[],
  preference: string,
  timeZone = 'Asia/Kolkata',
): OfferedSlot[] {
  const p = preference.toLowerCase();
  const hour = (s: OfferedSlot) =>
    Number(
      new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(
        new Date(s.startsAt),
      ),
    );
  const after = p.match(/after\s+(\d{1,2})\s*(pm|am)?|(\d{1,2})\s*(baje)?\s*(ke\s*)?baad/);
  const want = (s: OfferedSlot) => {
    const h = hour(s);
    if (after) {
      let n = Number(after[1] ?? after[3]);
      if ((after[2] === 'pm' || (!after[2] && n < 8)) && n < 12) n += 12;
      return h >= n;
    }
    if (/evening|शाम|shaam|after work|काम के बाद/.test(p)) return h >= 16;
    if (/afternoon|दोपहर|dopahar/.test(p)) return h >= 12 && h < 17;
    if (/morning|सुबह|subah/.test(p)) return h < 12;
    return true;
  };
  const matching = slots.filter(want);
  return [...matching, ...slots.filter((s) => !matching.includes(s))];
}

/**
 * Coordination agent (Flash): patient preference + adapter slots → one next
 * administrative step. The model may only pick from the offered slots; an
 * invented or malformed answer is rejected and the deterministic matcher is
 * used instead. Ordinary state changes never come from here.
 */
export async function coordinate(
  model: JsonModel | null,
  modelId: string,
  input: { caseId: string; approvalRevision: number; preference: string; slots: OfferedSlot[] },
): Promise<CoordinationResult> {
  const slots = input.slots.slice(0, 10);
  const fallback = (reason: string | null): CoordinationResult => {
    const ranked = rankByPreference(slots, input.preference);
    const best = ranked[0];
    return {
      proposal: {
        caseId: input.caseId,
        approvalRevision: input.approvalRevision,
        role: 'COORDINATION',
        intent: best ? 'REQUEST_BOOKING' : 'CREATE_HANDOFF',
        arguments: best ? { slotId: best.slotId } : { reasonCode: 'NO_SUITABLE_SLOT' },
        sourceRefs: [],
        missingFields: [],
      },
      ranked: ranked.slice(0, COORDINATION_LIMITS.maxToolOperations),
      source: 'fallback',
      rejectedReason: reason,
      promptVersion: COORDINATION_PROMPT.version,
    };
  };
  if (!model || slots.length === 0) return fallback(slots.length === 0 ? 'NO_SLOTS' : 'NO_MODEL');

  let raw: unknown;
  try {
    raw = (
      await callWithRetry(model, {
        model: modelId,
        system: COORDINATION_PROMPT.system,
        user: `OFFERED_SLOTS:\n${slots.map((s) => `- slotId=${s.slotId} | ${s.label} | ${s.location}`).join('\n')}\n\nPATIENT_PREFERENCE (data):\n"""${input.preference.slice(0, 500)}"""`,
        schema: SCHEMA,
        timeoutMs: 6_000,
        maxOutputTokens: 200,
      })
    ).data;
  } catch (e) {
    return fallback(e instanceof ModelError ? e.reason : 'PROVIDER_ERROR');
  }
  const r = raw as { intent?: string; slotId?: string; reasonCode?: string };
  const candidate = AgentProposal.safeParse({
    caseId: input.caseId,
    approvalRevision: input.approvalRevision,
    role: 'COORDINATION',
    intent: r?.intent,
    arguments: {
      ...(r?.slotId ? { slotId: r.slotId } : {}),
      ...(r?.reasonCode ? { reasonCode: r.reasonCode } : {}),
    },
    sourceRefs: [],
    missingFields: [],
  });
  if (!candidate.success) return fallback('MALFORMED_PROPOSAL');
  const p = candidate.data;
  if (p.intent === 'REQUEST_BOOKING') {
    const chosen = slots.find((s) => s.slotId === p.arguments.slotId);
    if (!chosen) return fallback('INVENTED_SLOT');
    const rest = rankByPreference(slots, input.preference).filter(
      (s) => s.slotId !== chosen.slotId,
    );
    return {
      proposal: p,
      ranked: [chosen, ...rest].slice(0, COORDINATION_LIMITS.maxToolOperations),
      source: 'model',
      rejectedReason: null,
      promptVersion: COORDINATION_PROMPT.version,
    };
  }
  if (p.intent === 'REQUEST_CALLBACK') return fallback('INTENT_NOT_ALLOWED');
  return {
    proposal: p,
    ranked: rankByPreference(slots, input.preference).slice(0, 3),
    source: 'model',
    rejectedReason: null,
    promptVersion: COORDINATION_PROMPT.version,
  };
}
