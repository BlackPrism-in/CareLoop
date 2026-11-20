import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

/**
 * Configuration inventory (MVP spec §22). Secrets are NOT here: they are
 * referenced from Secret Manager and injected at runtime by Cloud Run.
 */
export const AppConfig = z.object({
  APP_ENV: z.enum(['local', 'demo', 'staging', 'pilot']).default('local'),
  APP_REGION: z.string().min(1).default('asia-south1'),
  SITE_TIMEZONE: z.string().min(1).default('Asia/Kolkata'),
  GOOGLE_CLOUD_PROJECT: z.string().min(1).default('demo-careloop'),
  /** 'gemini-developer' (API key) or 'vertex' (service account). Pick one contracted surface. */
  GOOGLE_API_SURFACE: z.enum(['gemini-developer', 'vertex']).default('vertex'),
  /**
   * Vertex location for text models. gemini-3.8-flash is NOT offered in
   * asia-south1; 'global' covers 3.8 Flash and 3.5 Flash-Lite (verified 20 Nov 2026).
   */
  GOOGLE_CLOUD_LOCATION: z.string().min(1).default('global'),
  /** Vertex location for gemini-3.8-live: only us / eu / us-central1 (verified 20 Nov 2026). */
  LIVE_MODEL_LOCATION: z.string().min(1).default('us-central1'),
  INTAKE_MODEL_ID: z.string().min(1),
  COORDINATION_MODEL_ID: z.string().min(1),
  VERIFICATION_MODEL_ID: z.string().min(1),
  LIVE_MODEL_ID: z.string().min(1),
  BOOKING_ADAPTER: z.enum(['sandbox', 'manual', 'provider']).default('sandbox'),
  VOICE_ADAPTER: z.enum(['browser', 'provider']).default('browser'),
  MESSAGING_ADAPTER: z.enum(['simulated', 'provider']).default('simulated'),
  /** Master kill switch for automated patient contact. Must stay false outside a reviewed pilot. */
  OUTREACH_ENABLED: bool,
  MAX_CONTACT_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(2),
  MAX_CASE_AUDIO_SECONDS: z.coerce.number().int().min(0).max(600).default(180),
  CLOUD_TASKS_QUEUE: z.string().min(1).default('careloop-jobs'),
  WORKER_URL: z.string().url().optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
});
export type AppConfig = z.infer<typeof AppConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = AppConfig.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.OUTREACH_ENABLED && cfg.APP_ENV !== 'pilot') {
    throw new Error('OUTREACH_ENABLED=true is only allowed when APP_ENV=pilot');
  }
  return cfg;
}
