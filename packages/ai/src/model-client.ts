import type { GoogleGenAI } from '@google/genai';

export interface JsonCall {
  model: string;
  system: string;
  user: string;
  /** JSON Schema for the response; the model's output is still validated in code. */
  schema: Record<string, unknown>;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface JsonResult {
  data: unknown;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** The only way agents reach a text model. Swappable for a scripted fake in tests. */
export interface JsonModel {
  generateJson(call: JsonCall): Promise<JsonResult>;
}

export class ModelError extends Error {
  constructor(
    readonly reason: 'TIMEOUT' | 'MALFORMED_OUTPUT' | 'PROVIDER_ERROR',
    message: string = reason,
  ) {
    super(message);
  }
}

/** Gemini via the Google Gen AI SDK, structured JSON output, hard timeout. */
export class GenAiJsonModel implements JsonModel {
  constructor(private readonly client: GoogleGenAI) {}

  async generateJson(call: JsonCall): Promise<JsonResult> {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), call.timeoutMs ?? 10_000);
    try {
      const res = await this.client.models.generateContent({
        model: call.model,
        contents: call.user,
        config: {
          systemInstruction: call.system,
          responseMimeType: 'application/json',
          responseJsonSchema: call.schema,
          temperature: 0,
          maxOutputTokens: call.maxOutputTokens ?? 1024,
          abortSignal: abort.signal,
        },
      });
      let data: unknown;
      try {
        data = JSON.parse(res.text ?? '');
      } catch {
        throw new ModelError('MALFORMED_OUTPUT');
      }
      return {
        data,
        model: call.model,
        latencyMs: Date.now() - started,
        inputTokens: res.usageMetadata?.promptTokenCount ?? null,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? null,
      };
    } catch (e) {
      if (e instanceof ModelError) throw e;
      if (abort.signal.aborted) throw new ModelError('TIMEOUT');
      throw new ModelError('PROVIDER_ERROR', (e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Test double: returns whatever the script decides for each call. */
export class ScriptedJsonModel implements JsonModel {
  readonly calls: JsonCall[] = [];
  constructor(private readonly script: (call: JsonCall) => unknown) {}
  async generateJson(call: JsonCall): Promise<JsonResult> {
    this.calls.push(call);
    const out = this.script(call);
    if (out instanceof Error) throw out;
    return { data: out, model: call.model, latencyMs: 0, inputTokens: null, outputTokens: null };
  }
}

/** Calls the model, retrying once on malformed output only (MVP spec §16 bounded retries). */
export async function callWithRetry(model: JsonModel, call: JsonCall): Promise<JsonResult> {
  try {
    return await model.generateJson(call);
  } catch (e) {
    if (e instanceof ModelError && e.reason === 'MALFORMED_OUTPUT') return model.generateJson(call);
    throw e;
  }
}
