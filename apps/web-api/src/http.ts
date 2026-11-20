import { HTTP_STATUS, type ErrorCode, type ErrorEnvelope } from '@careloop/contracts';
import { newCorrelationId } from '@careloop/observability';

/** Consistent error envelope (MVP spec §15). */
export function errorResponse(
  code: ErrorCode,
  message: string,
  opts: { retryable?: boolean; fields?: Record<string, string> } = {},
) {
  const body: ErrorEnvelope = {
    code,
    message,
    correlationId: newCorrelationId(),
    retryable: opts.retryable ?? false,
    ...(opts.fields ? { fields: opts.fields } : {}),
  };
  return Response.json(body, { status: HTTP_STATUS[code] });
}
