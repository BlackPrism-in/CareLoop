import type { CaseQueries, CommandResult, EvidenceDoc, HandoffDoc } from '@careloop/domain';
import type { BookingDoc, FailedJobDoc } from '@careloop/jobs';

export type CaseDetail = NonNullable<Awaited<ReturnType<CaseQueries['caseDetail']>>> & {
  bookings: BookingDoc[];
  evidence: EvidenceDoc[];
  handoff: HandoffDoc | null;
};
export type Lookups = Awaited<ReturnType<CaseQueries['lookups']>> & {
  enabledLanguages?: ('hi-IN' | 'en-IN' | 'bn-IN')[];
};
export type BookingRow = BookingDoc & { patientAlias: string };
export type { BookingDoc, CommandResult, EvidenceDoc, FailedJobDoc, HandoffDoc };
