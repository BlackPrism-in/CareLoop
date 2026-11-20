import 'server-only';
import { loadConfig } from '@careloop/contracts';
import { CaseQueries, type CaseCommands } from '@careloop/domain';
import { createJobRuntime, JobQueries, type JobRuntime } from '@careloop/jobs';
import { createLogger } from '@careloop/observability';
import { firestore } from './firebase';

let runtime: JobRuntime | undefined;
let reads: CaseQueries | undefined;
let jobReads: JobQueries | undefined;

export function jobRuntime(): JobRuntime {
  if (!runtime)
    runtime = createJobRuntime(loadConfig(), firestore(), createLogger('careloop-web-api'));
  return runtime;
}

export const caseCommands = (): CaseCommands => jobRuntime().commands;

export function queries(): CaseQueries {
  if (!reads) reads = new CaseQueries(firestore());
  return reads;
}

export function jobQueries(): JobQueries {
  if (!jobReads) jobReads = new JobQueries(firestore());
  return jobReads;
}

/** Best-effort: push this case's new outbox items to the queue now; the sweep covers failures. */
export async function kick(tenantId: string, caseId: string): Promise<void> {
  await jobRuntime().dispatcher.dispatchCase(tenantId, caseId);
}
