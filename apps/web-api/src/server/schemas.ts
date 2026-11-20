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
