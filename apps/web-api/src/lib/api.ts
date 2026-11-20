'use client';
import type { ErrorEnvelope } from '@careloop/contracts';
import { clientAuth } from './firebase-client';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly envelope: ErrorEnvelope,
  ) {
    super(envelope.message);
  }
}

/**
 * Calls the CareLoop API with the user's ID token. Writes get a fresh
 * Idempotency-Key per user action; pass `idempotencyKey` to reuse one on retry.
 */
export async function api<T>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const user = clientAuth().currentUser;
  if (!user)
    throw new ApiError(401, {
      code: 'UNAUTHENTICATED',
      message: 'Sign in required',
      correlationId: '',
      retryable: false,
    });
  const token = await user.getIdToken();
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = opts.idempotencyKey ?? crypto.randomUUID();
  }
  const res = await fetch(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as ErrorEnvelope) ?? {
        code: 'INTERNAL',
        message: `Request failed (${res.status})`,
        correlationId: '',
        retryable: true,
      },
    );
  }
  return data as T;
}

/** Human-readable reason for guard failures (stable codes from the domain). */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Please retry.';
  const { code, message, fields } = e.envelope;
  if (code === 'VERSION_CONFLICT')
    return 'Someone else changed this case. Reload to see the latest version.';
  if (code === 'FORBIDDEN') return 'Your role cannot perform this action.';
  if (code === 'VALIDATION_FAILED' && fields)
    return `Check these fields: ${Object.keys(fields).join(', ')}`;
  return REASONS[message] ?? message;
}

const REASONS: Record<string, string> = {
  APPROVAL_CHECKLIST_INCOMPLETE: 'Every checklist item must be confirmed before approval.',
  ADULT_ELIGIBILITY_NOT_CONFIRMED: 'Adult eligibility is not confirmed for this patient.',
  CONTACT_BASIS_MISSING: 'There is no active contact permission for this patient.',
  OWNER_NOT_ACTIVE: 'The accountable owner is not an active staff member.',
  DUE_DATE_IN_PAST: 'The due date has already passed.',
  BOOKING_MUST_BE_RECONCILED: 'Reconcile the existing booking before editing.',
  NO_CHANGES: 'Nothing changed.',
  SOURCE_AUTHORITY_REQUIRED: 'Enter the upstream authority reference.',
  SLOT_NOT_OFFERED_BY_ADAPTER: 'That slot is no longer offered. Refresh the slot list.',
  BOOKING_UNKNOWN_RECONCILE_FIRST:
    'The last booking outcome is still being checked with the provider.',
  BOOKING_ALREADY_ACTIVE: 'A booking request is already in progress.',
  OUTREACH_DISABLED: 'Automated outreach is switched off for this environment.',
  OUTSIDE_CONTACT_WINDOW: "It's outside the lab's contact hours.",
  CONTACT_ATTEMPTS_EXHAUSTED: 'The contact attempt budget for this case is used up.',
  PATIENT_HAS_OPEN_CASES: 'This patient still has an open follow-up. Close or cancel it first.',
  LAB_MONTHLY_CONTACT_LIMIT_REACHED: "The lab's monthly contact allowance is used up.",
  LAB_MONTHLY_VOICE_LIMIT_REACHED: "The lab's monthly voice allowance is used up.",
  MODEL_UNAVAILABLE:
    'The AI model could not be reached. Fill in the form by hand, or check the Gemini configuration.',
  CASE_NOT_IN_CONTACT: 'Start contact first.',
  PATIENT_SUPPRESSED: 'The patient has opted out of automated contact.',
  AUDIO_BUDGET_EXHAUSTED: 'The voice time budget for this case is used up.',
  IDENTITY_METHOD_NOT_CONFIGURED: 'No identity verification method is configured for this lab yet.',
};
