import { z } from 'zod';
import { StaffRole, MembershipStatus } from './roles';
import {
  ActionType,
  AutomationPausedReason,
  BookingState,
  ContactChannel,
  EvidenceState,
  HandoffState,
  OutreachDisposition,
  SupportedLanguage,
  WorkflowState,
} from './states';

/**
 * Persisted document shapes beneath tenants/{tenantId} (MVP spec §13).
 * Phase 0 baseline; Phase 1 adds approvals, events, bookings, evidence,
 * handoffs, interactions, operations, inbox/outbox and jobs.
 * Timestamps are ISO-8601 UTC strings at the contract boundary.
 */
const id = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, 'ids are url-safe');
const isoTime = z.iso.datetime();

export const Tenant = z.strictObject({
  tenantId: id,
  displayName: z.string().min(1),
  timeZone: z.string().min(1),
  outreachPaused: z.boolean(),
  simulation: z.boolean(),
});
export type Tenant = z.infer<typeof Tenant>;

export const Site = z.strictObject({
  siteId: id,
  displayName: z.string().min(1),
  timeZone: z.string().min(1),
  /** Local contact window, 24h "HH:MM". Outreach outside it is blocked. */
  contactWindow: z.strictObject({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }),
});
export type Site = z.infer<typeof Site>;

export const Member = z.strictObject({
  uid: id,
  displayName: z.string().min(1),
  email: z.email(),
  roleSet: z.array(StaffRole).min(1),
  status: MembershipStatus,
  permittedSiteIds: z.array(id),
});
export type Member = z.infer<typeof Member>;

export const Patient = z.strictObject({
  patientId: id,
  externalRef: z.string().min(1),
  /** Display alias for list rows — never a real name in fixtures. */
  alias: z.string().min(1),
  /** Masked for display; the full value is stored encrypted in later phases. */
  contactMasked: z.string().min(1),
  ageEligibility: z.enum(['ADULT_CONFIRMED', 'UNKNOWN', 'INELIGIBLE']),
  language: SupportedLanguage,
  identityMethodRef: z.string().min(1),
});
export type Patient = z.infer<typeof Patient>;

export const Consent = z.strictObject({
  consentId: id,
  patientId: id,
  purpose: z.literal('FOLLOW_UP_COORDINATION'),
  channels: z.array(ContactChannel).min(1),
  noticeVersion: z.string().min(1),
  recordedBy: id,
  proofRef: z.string().min(1),
  grantedAt: isoTime,
  revokedAt: isoTime.nullable(),
  expiresAt: isoTime.nullable(),
  version: z.number().int().positive(),
});
export type Consent = z.infer<typeof Consent>;

export const Case = z.strictObject({
  caseId: id,
  siteId: id,
  patientId: id,
  sourceId: id,
  consentId: id,
  actionType: ActionType,
  actionText: z.string().min(1),
  dueAt: isoTime,
  ownerId: id,
  language: SupportedLanguage,
  approvalRevision: z.number().int().nonnegative(),
  approvalHash: z.string().nullable(),
  /** Set by the approve command; cleared when a material edit invalidates approval. */
  approvedAt: isoTime.nullable(),
  approvedBy: id.nullable(),
  /** Patient contact attempts consumed (budget: MAX_CONTACT_ATTEMPTS). Webhook retries never count. */
  contactAttempts: z.number().int().nonnegative(),
  /** Billed voice seconds consumed (budget: MAX_CASE_AUDIO_SECONDS). */
  audioSecondsUsed: z.number().int().nonnegative(),
  /** Confirmed booking start, copied from the reservation acknowledgment. */
  bookedStartsAt: isoTime.nullable(),
  /** External reservation reference from the acknowledgment; evidence can be matched against it. */
  bookingRef: z.string().nullable(),
  /** The open human handoff record for this case, if any. */
  activeHandoffId: z.string().nullable(),
  workflowState: WorkflowState,
  outreachDisposition: OutreachDisposition,
  handoffState: HandoffState,
  evidenceState: EvidenceState,
  bookingState: BookingState,
  automationPausedReason: AutomationPausedReason.nullable(),
  fingerprint: z.string().min(1),
  version: z.number().int().positive(),
  createdBy: id,
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type Case = z.infer<typeof Case>;

export const Source = z.strictObject({
  sourceId: id,
  sourceAuthority: z.string().min(1),
  documentType: z.enum(['FORM', 'CSV_ROW', 'INSTRUCTION_PDF']),
  reference: z.string().min(1),
});
export type Source = z.infer<typeof Source>;

/** Sandbox booking inventory. Availability comes only from here, never from a model. */
export const Slot = z.strictObject({
  slotId: id,
  siteId: id,
  actionType: ActionType,
  location: z.string().min(1),
  startsAt: isoTime,
  endsAt: isoTime,
  capacity: z.number().int().positive(),
  reserved: z.number().int().nonnegative(),
});
export type Slot = z.infer<typeof Slot>;
