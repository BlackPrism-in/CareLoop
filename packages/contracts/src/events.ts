import { z } from 'zod';

export const ActorType = z.enum(['STAFF', 'PATIENT', 'AGENT', 'SYSTEM', 'PROVIDER']);
export type ActorType = z.infer<typeof ActorType>;

/**
 * Internal event envelope (MVP spec §14). Schema changes must be additive or
 * versioned. Payload stays minimal; logs reference correlationId, not patients.
 */
export const EventEnvelope = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  correlationId: z.string().min(1),
  operationId: z.string().min(1).optional(),
  actorType: ActorType,
  actorId: z.string().min(1),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  previousVersion: z.number().int().nonnegative().optional(),
  nextVersion: z.number().int().positive().optional(),
  sourceRef: z.string().optional(),
  /** True for anything produced by a sandbox/simulated adapter. Must be shown in the UI. */
  simulation: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Provider event after signature verification and normalization (MVP spec §14). */
export const NormalizedProviderEvent = z.strictObject({
  eventId: z.string().min(1),
  eventType: z.enum([
    'APPOINTMENT_CONFIRMED',
    'APPOINTMENT_CANCELLED',
    'APPOINTMENT_ATTENDED',
    'SAMPLE_COLLECTED',
  ]),
  sourceSystem: z.string().min(1),
  externalBookingRef: z.string().optional(),
  patientExternalRef: z.string().min(1),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  sourceSequence: z.number().int().optional(),
  simulation: z.boolean(),
});
export type NormalizedProviderEvent = z.infer<typeof NormalizedProviderEvent>;
