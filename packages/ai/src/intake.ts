import { z } from 'zod';
import { ActionType, SupportedLanguage } from '@careloop/contracts';
import { callWithRetry, type JsonModel } from './model-client';
import { INTAKE_PROMPT } from './prompts';

const FIELD_NAMES = [
  'actionType',
  'actionText',
  'dueDate',
  'sourceAuthority',
  'reference',
  'language',
] as const;
type FieldName = (typeof FIELD_NAMES)[number];

const MAX_INPUT = 8_000;
/** The reviewer must supply these if extraction can't; language is optional. */
const REQUIRED: FieldName[] = [
  'actionType',
  'actionText',
  'dueDate',
  'sourceAuthority',
  'reference',
];

const RAW = z.object({
  fields: z.array(z.object({ name: z.string(), value: z.string(), sourceSpan: z.string() })),
  missingFields: z.array(z.string()).optional(),
});

const SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: [...FIELD_NAMES] },
          value: { type: 'string' },
          sourceSpan: { type: 'string' },
        },
        required: ['name', 'value', 'sourceSpan'],
      },
    },
    missingFields: { type: 'array', items: { type: 'string', enum: [...FIELD_NAMES] } },
  },
  required: ['fields'],
};

export interface ExtractedField {
  value: string;
  /** Exact text from the source that supports the value; always verified to exist. */
  sourceSpan: string;
  start: number;
}

export interface IntakeResult {
  fields: Partial<Record<FieldName, ExtractedField>>;
  missingFields: FieldName[];
  /** Fields the model proposed that failed deterministic checks. */
  rejected: { name: string; reason: string }[];
  promptVersion: string;
  model: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const VALIDATORS: Record<FieldName, (v: string) => string | null> = {
  actionType: (v) => (ActionType.safeParse(v).success ? v : null),
  actionText: (v) => (v.trim().length > 0 && v.length <= 500 ? v.trim() : null),
  dueDate: (v) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null,
  sourceAuthority: (v) => (v.trim().length > 0 && v.length <= 120 ? v.trim() : null),
  reference: (v) => (v.trim().length > 0 && v.length <= 120 ? v.trim() : null),
  language: (v) => (SupportedLanguage.safeParse(v).success ? v : null),
};

/**
 * Intake agent (Flash-Lite): approved instruction text → administrative fields
 * with source spans. No tools, no outreach. Output is accepted only if each
 * span appears verbatim in the source and each value passes its validator;
 * anything else becomes a missing field for the human reviewer. The reviewer
 * still approves every case (MVP spec §07).
 */
export async function runIntake(
  model: JsonModel,
  modelId: string,
  source: string,
): Promise<IntakeResult> {
  const text = source.slice(0, MAX_INPUT);
  const res = await callWithRetry(model, {
    model: modelId,
    system: INTAKE_PROMPT.system,
    // The document is data. Closing-tag look-alikes inside it are neutralised.
    user: `<document>\n${text.replaceAll('</document>', '</ document>')}\n</document>`,
    schema: SCHEMA,
    timeoutMs: 15_000,
  });
  const parsed = RAW.safeParse(res.data);
  const result: IntakeResult = {
    fields: {},
    missingFields: [],
    rejected: [],
    promptVersion: INTAKE_PROMPT.version,
    model: modelId,
  };
  if (!parsed.success) {
    result.missingFields = [...REQUIRED];
    result.rejected.push({ name: '*', reason: 'MALFORMED_OUTPUT' });
    return result;
  }
  const haystack = norm(text);
  for (const f of parsed.data.fields) {
    if (!(FIELD_NAMES as readonly string[]).includes(f.name)) {
      result.rejected.push({ name: f.name, reason: 'FIELD_NOT_ALLOWED' });
      continue;
    }
    const name = f.name as FieldName;
    if (result.fields[name]) continue; // first value wins; duplicates are ignored
    const span = norm(f.sourceSpan);
    const start = span ? haystack.indexOf(span) : -1;
    if (start < 0) {
      result.rejected.push({ name, reason: 'SPAN_NOT_IN_SOURCE' });
      continue;
    }
    const value = VALIDATORS[name](f.value);
    if (value === null) {
      result.rejected.push({ name, reason: 'INVALID_VALUE' });
      continue;
    }
    result.fields[name] = { value, sourceSpan: span, start };
  }
  result.missingFields = REQUIRED.filter((n) => !result.fields[n]);
  return result;
}
