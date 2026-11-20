import type { ErrorCode } from '@careloop/contracts';

/**
 * A rejected command. `reason` is a stable machine code for the UI and tests;
 * `message` is safe to show staff and must never contain patient data.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly reason: string,
    message: string = reason,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const guardFailed = (reason: string, message?: string) =>
  new DomainError('DOMAIN_GUARD_FAILED', reason, message);
export const forbidden = (reason: string) => new DomainError('FORBIDDEN', reason);
export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what}_NOT_FOUND`);
export const versionConflict = (expected: number, actual: number) =>
  new DomainError(
    'VERSION_CONFLICT',
    'VERSION_CONFLICT',
    `expected version ${expected}, found ${actual}`,
  );
