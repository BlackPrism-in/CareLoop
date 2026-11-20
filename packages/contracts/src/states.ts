import { z } from 'zod';

/**
 * Canonical state model (MVP spec §12). The axes are independent: a case can be
 * BOOKED while a handoff is PENDING and evidence is NONE. None of the outreach,
 * handoff or booking values imply completion.
 */
export const WorkflowState = z.enum([
  'DRAFT',
  'READY',
  'CONTACTING',
  'AWAITING_BOOKING',
  'BOOKED',
  'AWAITING_EVIDENCE',
  'COMPLETED_VERIFIED',
  'CANCELLED',
]);
export type WorkflowState = z.infer<typeof WorkflowState>;

export const OutreachDisposition = z.enum([
  'NOT_STARTED',
  'RETRY_SCHEDULED',
  'REACHED',
  'DECLINED',
  'OPTED_OUT',
  'UNREACHABLE',
]);
export type OutreachDisposition = z.infer<typeof OutreachDisposition>;

export const HandoffState = z.enum(['NONE', 'PENDING', 'ACKNOWLEDGED', 'RESOLVED']);
export type HandoffState = z.infer<typeof HandoffState>;

export const EvidenceState = z.enum([
  'NONE',
  'SELF_REPORTED',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'CONFLICTED',
]);
export type EvidenceState = z.infer<typeof EvidenceState>;

/** UNKNOWN means a provider side effect may have happened; it blocks blind retry. */
export const BookingState = z.enum(['NONE', 'REQUESTED', 'CONFIRMED', 'UNKNOWN', 'CANCELLED']);
export type BookingState = z.infer<typeof BookingState>;

export const AutomationPausedReason = z.enum([
  'REVIEW_REQUIRED',
  'CONSENT',
  'LANGUAGE',
  'BUDGET',
  'HANDOFF',
  'INTEGRATION',
  'SITE_PAUSED',
]);
export type AutomationPausedReason = z.infer<typeof AutomationPausedReason>;

export const ActionType = z.enum(['CONSULTATION', 'ORDERED_TEST']);
export type ActionType = z.infer<typeof ActionType>;

/** Languages enabled for patient contact. Bengali is gated on local-speaker evaluation. */
export const SupportedLanguage = z.enum(['hi-IN', 'en-IN']);
export type SupportedLanguage = z.infer<typeof SupportedLanguage>;

export const ContactChannel = z.enum(['BROWSER_VOICE', 'PSTN_VOICE', 'WHATSAPP', 'SMS']);
export type ContactChannel = z.infer<typeof ContactChannel>;
