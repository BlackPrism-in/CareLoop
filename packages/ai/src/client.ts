import { GoogleGenAI } from '@google/genai';
import type { AppConfig } from '@careloop/contracts';

/**
 * One contracted API surface per deployment. Vertex uses the runtime service
 * account (no key); the Developer API reads GEMINI_API_KEY, injected from
 * Secret Manager. Keys are never sent to a browser.
 */
export function createGenAIClient(
  cfg: AppConfig,
  opts: { purpose?: 'text' | 'live'; env?: Record<string, string | undefined> } = {},
): GoogleGenAI {
  const env = opts.env ?? process.env;
  if (cfg.GOOGLE_API_SURFACE === 'vertex') {
    // gemini-3.8-live is served from different locations than the text models.
    const location = opts.purpose === 'live' ? cfg.LIVE_MODEL_LOCATION : cfg.GOOGLE_CLOUD_LOCATION;
    return new GoogleGenAI({ vertexai: true, project: cfg.GOOGLE_CLOUD_PROJECT, location });
  }
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey)
    throw new Error('GEMINI_API_KEY is required for GOOGLE_API_SURFACE=gemini-developer');
  return new GoogleGenAI({ apiKey });
}
