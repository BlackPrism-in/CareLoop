import { HTTP_STATUS, type ErrorCode, type ErrorEnvelope } from '@careloop/contracts';
import { DomainError } from '@careloop/domain';
import { createLogger, newCorrelationId } from '@careloop/observability';
import { ZodError } from 'zod';

const log = createLogger('careloop-web-api');

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

const RETRYABLE: ErrorCode[] = ['THROTTLED', 'INTERNAL'];

export function errorResponse(
  code: ErrorCode,
  message: string,
  correlationId: string = newCorrelationId(),
  fields?: Record<string, string>,
) {
  const body: ErrorEnvelope = {
    code,
    message,
    correlationId,
    retryable: RETRYABLE.includes(code),
    ...(fields ? { fields } : {}),
  };
  return Response.json(body, { status: HTTP_STATUS[code] });
}

/** Maps any thrown error to the §15 envelope. Unknown errors never leak details. */
export function toErrorResponse(e: unknown, correlationId: string): Response {
  if (e instanceof DomainError) {
    return errorResponse(
      e.code,
      e.code === 'DOMAIN_GUARD_FAILED' ? e.reason : e.message,
      correlationId,
      e.fields ?? (e.reason !== e.message ? { reason: e.reason } : undefined),
    );
  }
  if (e instanceof HttpError) return errorResponse(e.code, e.message, correlationId, e.fields);
  if (e instanceof ZodError) {
    const fields = Object.fromEntries(e.issues.map((i) => [i.path.join('.') || '_', i.message]));
    return errorResponse('VALIDATION_FAILED', 'Request validation failed', correlationId, fields);
  }
  if (e instanceof SyntaxError)
    return errorResponse('VALIDATION_FAILED', 'Malformed JSON body', correlationId);
  log.error('unhandled error', { correlationId, error: e instanceof Error ? e.name : 'unknown' });
  return errorResponse('INTERNAL', 'Something went wrong', correlationId);
}
