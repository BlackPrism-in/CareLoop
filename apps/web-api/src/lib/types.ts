import type { CaseQueries, CommandResult } from '@careloop/domain';

export type CaseDetail = NonNullable<Awaited<ReturnType<CaseQueries['caseDetail']>>>;
export type Lookups = Awaited<ReturnType<CaseQueries['lookups']>>;
export type { CommandResult };
