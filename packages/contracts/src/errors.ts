import { z } from 'zod';

/** HTTP semantics from MVP spec §15. */
export const ErrorCode = z.enum([
  'VALIDATION_FAILED', // 400
  'UNAUTHENTICATED', // 401
  'FORBIDDEN', // 403
  'NOT_FOUND', // 404 — also used for cross-tenant references, to avoid leakage
  'VERSION_CONFLICT', // 409
  'SLOT_CONFLICT', // 409
  'IDEMPOTENCY_KEY_REUSED', // 409
  'DOMAIN_GUARD_FAILED', // 422
  'THROTTLED', // 429
  'INTERNAL', // 500
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  SLOT_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  DOMAIN_GUARD_FAILED: 422,
  THROTTLED: 429,
  INTERNAL: 500,
};

/** Error envelope. Never include secrets or patient data in `message` or `fields`. */
export const ErrorEnvelope = z.object({
  code: ErrorCode,
  message: z.string(),
  correlationId: z.string(),
  retryable: z.boolean(),
  fields: z.record(z.string(), z.string()).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
