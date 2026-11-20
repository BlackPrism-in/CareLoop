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
