import { GoogleGenAI } from '@google/genai';
import { FIELD_KEYS } from './validate';

export type ModelCallResult = {
  raw: unknown;
  modelId: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
};

// Thin adapter: swap providers or mock in tests by replacing only this.
export interface IntakeModel {
  call(args: { system: string; user: string; signal: AbortSignal }): Promise<ModelCallResult>;
}

const intakeResponseSchema = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: FIELD_KEYS },
          value: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          sourceSpan: {
            type: 'object',
            properties: {
              start: { type: 'integer', minimum: 0 },
              end: { type: 'integer', minimum: 0 },
              quote: { type: 'string' },
            },
            required: ['start', 'end', 'quote'],
            additionalProperties: false,
          },
        },
        required: ['key', 'value', 'confidence', 'sourceSpan'],
        additionalProperties: false,
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['fields', 'warnings'],
  additionalProperties: false,
};

export function createGeminiIntakeModel(opts: {
  apiKey: string;
  modelId: string; // pinned in config (FLASH_LITE_MODEL_ID), never hardcoded
  temperature?: number;
  maxOutputTokens?: number;
}): IntakeModel {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  return {
    async call({ system, user, signal }) {
      const t0 = Date.now();
      const res = await ai.models.generateContent({
        model: opts.modelId,
        contents: user,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseJsonSchema: intakeResponseSchema,
          temperature: opts.temperature ?? 0,
          maxOutputTokens: opts.maxOutputTokens ?? 1024,
          abortSignal: signal,
        },
      });
      const text = (res.text ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      const raw = JSON.parse(text); // throws on malformed output -> handled by runIntake
      return {
        raw,
        modelId: opts.modelId,
        latencyMs: Date.now() - t0,
        inputTokens: res.usageMetadata?.promptTokenCount,
        outputTokens: res.usageMetadata?.candidatesTokenCount,
      };
    },
  };
}
