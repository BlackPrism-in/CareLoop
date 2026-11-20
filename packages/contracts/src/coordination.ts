import { z } from 'zod';
import { ActionType, BookingState, HandoffState, WorkflowState } from './states';

export const HandoffReasonCode = z.enum([
  'MEDICAL_QUESTION',
  'NO_SLOTS',
  'BOOKING_UNKNOWN',
  'IDENTITY_MISMATCH',
  'PATIENT_REQUESTS_HUMAN',
  'BUDGET_EXHAUSTED',
  'OTHER',
]);
export type HandoffReasonCode = z.infer<typeof HandoffReasonCode>;

export const DayOfWeek = z.enum([
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
]);
export const TimePeriod = z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'ANY']);

/** Structured, patient-confirmed preferences. No raw transcript is provided to this agent. */
export const CoordinationPreferences = z.strictObject({
  preferredDays: z.array(DayOfWeek).max(7),
  preferredTimePeriods: z.array(TimePeriod).max(4),
  unavailableTimePeriods: z.array(TimePeriod).max(4),
  avoidWorkHours: z.boolean(),
  earliestDate: z.iso.date().optional(),
  latestDate: z.iso.date().optional(),
  barriers: z.array(z.string().trim().min(1).max(160)).max(8),
});
export type CoordinationPreferences = z.infer<typeof CoordinationPreferences>;

export const CoordinationSlot = z.strictObject({
  slotId: z.string().min(1),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  location: z.string().min(1),
});
export type CoordinationSlot = z.infer<typeof CoordinationSlot>;

/** Server snapshot supplied to the model; tenant membership remains gateway-only. */
export const CoordinationContext = z.strictObject({
  caseId: z.string().min(1),
  approvalRevision: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
  siteId: z.string().min(1),
  timeZone: z.string().min(1),
  actionType: ActionType,
  workflowState: WorkflowState,
  bookingState: BookingState,
  handoffState: HandoffState,
  consentActive: z.boolean(),
  optedOut: z.boolean(),
  identityVerified: z.boolean(),
  patientRequestedCallback: z.boolean(),
  patientConfirmedSlotId: z.string().min(1).optional(),
  contactAttempts: z.number().int().nonnegative(),
  maxContactAttempts: z.number().int().nonnegative(),
  contactWindowOpen: z.boolean(),
  preferences: CoordinationPreferences,
  offeredSlots: z.array(CoordinationSlot).max(50),
  remainingToolOperations: z.number().int().nonnegative().max(3),
  remainingReplans: z.number().int().nonnegative().max(2),
});
export type CoordinationContext = z.infer<typeof CoordinationContext>;

const ListSlotsCall = z.strictObject({
  name: z.literal('list_slots'),
  arguments: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }),
});
const RequestBookingCall = z.strictObject({
  name: z.literal('request_booking'),
  arguments: z.strictObject({ slotId: z.string().min(1) }),
});
const RequestCallbackCall = z.strictObject({
  name: z.literal('request_callback'),
  arguments: z.strictObject({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() })
    .refine((args) => (args.from === undefined) === (args.to === undefined), 'from and to must be provided together'),
});
const CreateHandoffCall = z.strictObject({
  name: z.literal('create_handoff'),
  arguments: z.strictObject({
    reasonCode: HandoffReasonCode,
    summary: z.string().trim().min(1).max(280),
  }),
});

export const CoordinationToolCall = z.discriminatedUnion('name', [
  ListSlotsCall,
  RequestBookingCall,
  RequestCallbackCall,
  CreateHandoffCall,
]);
export type CoordinationToolCall = z.infer<typeof CoordinationToolCall>;

export const CoordinationFinishOutcome = z.enum([
  'BOOKING_REQUESTED',
  'CALLBACK_REQUESTED',
  'HANDOFF_CREATED',
  'OPT_OUT_STOPPED',
  'NO_ACTION',
]);

/** Exactly one bounded tool call or a non-completion outcome; unknown keys fail closed. */
export const CoordinationStepProposal = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('tool_call'),
    toolCall: CoordinationToolCall,
    rationale: z.string().trim().min(1).max(280),
  }),
  z.strictObject({
    type: z.literal('finish'),
    outcome: CoordinationFinishOutcome,
    rationale: z.string().trim().min(1).max(280),
  }),
]);
export type CoordinationStepProposal = z.infer<typeof CoordinationStepProposal>;

export const COORDINATION_BUDGET = {
  maxToolOperations: 3,
  maxReplans: 2,
  maxWallTimeMs: 20_000,
  maxOutputTokens: 1_024,
  maxTotalTokens: 6_000,
} as const;
