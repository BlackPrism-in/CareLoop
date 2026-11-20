import type { CaseQueries, CommandResult } from '@careloop/domain';
import type { BookingDoc, FailedJobDoc } from '@careloop/jobs';

export type CaseDetail = NonNullable<Awaited<ReturnType<CaseQueries['caseDetail']>>> & {
  bookings: BookingDoc[];
};
export type Lookups = Awaited<ReturnType<CaseQueries['lookups']>>;
export type BookingRow = BookingDoc & { patientAlias: string };
export type { BookingDoc, CommandResult, FailedJobDoc };
