import { randomUUID } from 'node:crypto';

/**
 * Structured JSON logging for Cloud Logging. Logs carry correlation IDs and
 * redacted metadata only — never patient names, contact details, transcripts
 * or tokens (MVP spec §19).
 */
const REDACT_KEYS =
  /(phone|mobile|contact|email|name|address|token|secret|password|authorization|apikey|api_key|transcript|dob|otp)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        REDACT_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(service: string, bindings: Record<string, unknown> = {}): Logger {
  const write = (severity: Severity, message: string, meta?: Record<string, unknown>) => {
    const entry = {
      severity,
      service,
      message,
      time: new Date().toISOString(),
      ...(redact({ ...bindings, ...meta }) as object),
    };
    (severity === 'ERROR' ? console.error : console.log)(JSON.stringify(entry));
  };
  return {
    debug: (m, x) => write('DEBUG', m, x),
    info: (m, x) => write('INFO', m, x),
    warn: (m, x) => write('WARNING', m, x),
    error: (m, x) => write('ERROR', m, x),
    child: (b) => createLogger(service, { ...bindings, ...b }),
  };
}

export function newCorrelationId(): string {
  return randomUUID();
}
