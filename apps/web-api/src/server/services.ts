import 'server-only';
import { loadConfig } from '@careloop/contracts';
import { CaseCommands, CaseQueries, FirestoreStore } from '@careloop/domain';
import { firestore } from './firebase';

let commands: CaseCommands | undefined;
let reads: CaseQueries | undefined;

export function caseCommands(): CaseCommands {
  if (!commands) {
    const cfg = loadConfig();
    commands = new CaseCommands({
      store: new FirestoreStore(firestore()),
      config: {
        outreachEnabled: cfg.OUTREACH_ENABLED,
        maxContactAttempts: cfg.MAX_CONTACT_ATTEMPTS,
        maxCaseAudioSeconds: cfg.MAX_CASE_AUDIO_SECONDS,
      },
    });
  }
  return commands;
}

export function queries(): CaseQueries {
  if (!reads) reads = new CaseQueries(firestore());
  return reads;
}
