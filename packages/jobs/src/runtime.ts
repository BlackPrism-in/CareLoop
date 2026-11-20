import type { Firestore } from 'firebase-admin/firestore';
import type { AppConfig } from '@careloop/contracts';
import {
  ManualBookingAdapter,
  SandboxBookingAdapter,
  whatsAppSenderFor,
  type BookingAdapter,
  type WhatsAppSender,
} from '@careloop/adapters';
import { CaseCommands, FirestoreStore } from '@careloop/domain';
import type { Logger } from '@careloop/observability';
import { OutboxDispatcher } from './dispatcher';
import { createHandlers } from './handlers';
import { CloudTasksQueue, LocalHttpQueue, type TaskQueue } from './queue';
import { JobRunner } from './runner';
import { PatientMessenger } from './patient-messages';
import { TimeSweeps } from './sweeps';

export interface JobRuntime {
  commands: CaseCommands;
  booking: BookingAdapter;
  queue: TaskQueue;
  dispatcher: OutboxDispatcher;
  runner: JobRunner;
  sweeps: TimeSweeps;
  whatsapp: WhatsAppSender;
  messenger: PatientMessenger;
}

export function bookingAdapterFor(cfg: AppConfig, db: Firestore): BookingAdapter {
  switch (cfg.BOOKING_ADAPTER) {
    case 'sandbox':
      return new SandboxBookingAdapter(db);
    case 'manual':
      return new ManualBookingAdapter();
    case 'provider':
      throw new Error(
        'No contracted booking provider is configured yet (BOOKING_ADAPTER=provider)',
      );
  }
}

export function queueFor(cfg: AppConfig, log: Logger): TaskQueue {
  return cfg.TASK_QUEUE_MODE === 'cloud-tasks'
    ? new CloudTasksQueue({
        project: cfg.GOOGLE_CLOUD_PROJECT,
        location: cfg.APP_REGION,
        queue: cfg.CLOUD_TASKS_QUEUE,
        workerUrl: cfg.WORKER_URL,
        invokerEmail: cfg.TASKS_INVOKER_EMAIL!,
      })
    : new LocalHttpQueue(cfg.WORKER_URL, log);
}

/** Wires the case commands, booking adapter, queue, dispatcher and runner from config. */
export function createJobRuntime(cfg: AppConfig, db: Firestore, log: Logger): JobRuntime {
  const commands = new CaseCommands({
    store: new FirestoreStore(db),
    config: {
      outreachEnabled: cfg.OUTREACH_ENABLED,
      // Simulated messaging sends nothing; live WhatsApp outside the pilot reaches only test phones.
      whatsappTestRecipientsOnly: cfg.APP_ENV !== 'pilot',
      maxContactAttempts: cfg.MAX_CONTACT_ATTEMPTS,
      maxCaseAudioSeconds: cfg.MAX_CASE_AUDIO_SECONDS,
      enabledLanguages: cfg.ENABLED_LANGUAGES,
    },
  });
  const booking = bookingAdapterFor(cfg, db);
  const queue = queueFor(cfg, log);
  const whatsapp = whatsAppSenderFor(cfg);
  const messenger = new PatientMessenger({ db, whatsapp, appUrl: cfg.PATIENT_APP_URL, log });
  return {
    commands,
    booking,
    queue,
    dispatcher: new OutboxDispatcher(db, queue, log),
    runner: new JobRunner(db, createHandlers({ db, commands, booking, log, messenger }), log),
    sweeps: new TimeSweeps(db, commands, log, { messenger }),
    whatsapp,
    messenger,
  };
}
