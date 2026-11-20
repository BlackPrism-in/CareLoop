import { z } from 'zod';
import { ActionType, SupportedLanguage, WorkflowState } from '@careloop/contracts';
import { REQUIRED_CHECKS } from '@careloop/domain';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** POST /v1/cases. tenantId and creatorId are NOT accepted; strict rejects them. */
export const CreateCaseBody = z.strictObject({
  caseId: id.optional(),
  siteId: id,
  patientId: id,
  consentId: id,
  source: z.strictObject({
    sourceAuthority: z.string().trim().min(1).max(120),
    reference: z.string().trim().min(1).max(120),
  }),
  actionType: ActionType,
  actionText: z.string().trim().min(1).max(500),
  dueAt: z.iso.datetime(),
  ownerId: id,
  language: SupportedLanguage,
});

export const EditDraftBody = z.strictObject({
  expectedVersion: z.number().int().positive(),
  edit: z
    .strictObject({
      actionText: z.string().trim().min(1).max(500).optional(),
      dueAt: z.iso.datetime().optional(),
      ownerId: id.optional(),
      language: SupportedLanguage.optional(),
      consentId: id.optional(),
    })
    .refine((e) => Object.values(e).some((v) => v !== undefined), 'at least one field is required'),
});

export const ApproveBody = z.strictObject({
  expectedVersion: z.number().int().positive(),
  sourceAuthorityRef: z.string().trim().min(1).max(120),
  checkedFields: z.array(z.enum(REQUIRED_CHECKS)).min(1),
});

export const ListCasesQuery = z.object({
  workflowState: WorkflowState.optional(),
  owner: z.enum(['me']).optional(),
  view: z.enum(['handoffs', 'proof']).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const version = z.number().int().positive();

export const ContactRequestBody = z.strictObject({
  expectedVersion: version,
  channel: z.literal('BROWSER_VOICE'),
});

/** Staff recording what the patient asked for on a staff-handled call. */
export const PatientRequestBody = z.strictObject({
  expectedVersion: version,
  request: z.enum(['BOOK', 'CALLBACK']),
});

export const BookingRequestBody = z.strictObject({
  expectedVersion: version,
  slotId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  /** The patient heard the date, time and location read back and said yes (MVP-04). */
  patientConfirmedSlot: z.literal(true),
});

export const CancelBookingBody = z.strictObject({
  expectedVersion: version,
  reason: z.string().trim().min(1).max(300),
});

export const ManualConfirmBody = z.strictObject({
  expectedVersion: version,
  externalRef: z.string().trim().min(1).max(120),
  startsAt: z.iso.datetime(),
});

export const BookingListQuery = z.object({
  status: z.enum(['open', 'confirmed', 'closed']).default('open'),
});

/** Slot id used with the manual adapter: staff arrange the time outside CareLoop. */
export const STAFF_ARRANGED = 'STAFF_ARRANGED';

export const VoiceSessionBody = z.strictObject({
  caseId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

export const IntakeBody = z.strictObject({ text: z.string().trim().min(20).max(8000) });

const isoDateTime = z.iso.datetime();
const shortText = (max: number) => z.string().trim().min(1).max(max);

export const RecordEvidenceBody = z.strictObject({
  expectedVersion: version,
  kind: z.enum(['STAFF_RECORD', 'SELF_REPORT']),
  issuer: shortText(120),
  eventType: z.enum(['APPOINTMENT_ATTENDED', 'SAMPLE_COLLECTED']),
  occurredAt: isoDateTime,
  sourceRef: shortText(200),
  patientRef: z.string().trim().max(120).optional(),
  bookingRef: z.string().trim().max(120).optional(),
  /** Administrative excerpt only (attendance line, receipt line). Not report content. */
  excerpt: z.string().trim().max(2000).optional(),
});

export const AttestBody = z.strictObject({
  expectedVersion: version,
  decision: z.enum(['VERIFY', 'REJECT']),
  reason: shortText(300),
  sourceRef: z.string().trim().max(200).default(''),
});

export const SimulateEventBody = z.strictObject({
  scenario: z.enum(['MATCHING', 'WRONG_PATIENT', 'WRONG_BOOKING']),
});

export const HandoffActionBody = z.strictObject({
  expectedVersion: version,
  resolution: z.string().trim().max(500).optional(),
  resumeAutomation: z.boolean().optional(),
  ownerId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
});

export const ReasonBody = z.strictObject({ expectedVersion: version, reason: shortText(300) });
export const RevokeConsentBody = z.strictObject({ reason: shortText(300) });
export const OutreachPauseBody = z.strictObject({ paused: z.boolean(), reason: shortText(300) });

export const PatientSessionBody = z.strictObject({
  token: z.string().max(80),
  code: z.string().max(10),
});
export const PatientActionBody = z.strictObject({
  action: z.enum(['REQUEST_CHANGE', 'REQUEST_CALLBACK', 'STOP_CONTACT']),
});

export const ReasonOnlyBody = z.strictObject({ reason: z.string().trim().min(1).max(300) });

export const CsvIntakeBody = z.strictObject({
  csv: z.string().min(1).max(64_000),
  commit: z.boolean().default(false),
  previewHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

/** Base64 PDF, ≤ 5 MB decoded. The file is processed in memory and not stored. */
export const PdfIntakeBody = z.strictObject({ pdfBase64: z.string().min(10).max(7_000_000) });

export const TimeLogBody = z.strictObject({
  caseId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  minutes: z.number().int().min(1).max(240),
  activity: z.enum(['CALL', 'BOOKING', 'HANDOFF', 'REVIEW', 'EVIDENCE', 'INTAKE', 'OTHER']),
  note: z.string().trim().max(200).optional(),
});

export const ReviewBody = z.strictObject({
  outcome: z.enum(['OK', 'ISSUE']),
  issues: z
    .array(
      z.enum([
        'UNSUPPORTED_CLAIM',
        'MEDICAL_CONTENT',
        'IDENTITY',
        'LANGUAGE',
        'TONE',
        'TOOL_MISUSE',
        'OTHER',
      ]),
    )
    .max(7)
    .default([]),
  note: z.string().trim().max(500).optional(),
});

export const PilotConfigBody = z.strictObject({
  phase: z.enum(['NOT_STARTED', 'BASELINE', 'INTERVENTION', 'ENDED']),
  concurrentComparison: z.boolean(),
  interventionShare: z.number().min(0.1).max(0.9),
  supervisedReviewFirstN: z.number().int().min(0).max(1000),
  costRates: z.strictObject({
    voicePerMinuteInr: z.number().min(0).max(100),
    messageInr: z.number().min(0).max(100),
    modelPerCaseInr: z.number().min(0).max(1000),
    directSupportPerMonthInr: z.number().min(0).max(1_000_000),
  }),
  pricing: z.strictObject({
    sitePerMonthInr: z.number().min(0),
    perEnrolledCaseInr: z.number().min(0),
  }),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const SiteBody = z.strictObject({
  siteId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  displayName: z.string().trim().min(1).max(120),
  timeZone: z.string().min(1).max(64),
  contactWindow: z.strictObject({ start: hhmm, end: hhmm }),
});
export const MemberSitesBody = z.strictObject({ permittedSiteIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(30) });
export const StatementBody = z.strictObject({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
