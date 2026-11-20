import { z } from 'zod';

/** The Intake agent may propose only these administrative fields. */
export const INTAKE_FIELD_KEYS = [
  'patient_name',
  'patient_ref',
  'patient_phone',
  'preferred_language',
  'action_type',
  'action_name',
  'ordering_clinician',
  'due_date',
  'source_ref',
] as const;

export const IntakeFieldKey = z.enum(INTAKE_FIELD_KEYS);
export type IntakeFieldKey = z.infer<typeof IntakeFieldKey>;

/** Provisional approval checklist, retained from the current prototype pending product sign-off. */
export const REQUIRED_FIELD_KEYS = [
  'patient_name',
  'patient_phone',
  'action_type',
  'action_name',
  'ordering_clinician',
  'due_date',
  'source_ref',
] as const satisfies readonly IntakeFieldKey[];

export const IntakeField = z.strictObject({
  key: IntakeFieldKey,
  value: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
  sourceSpan: z.strictObject({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    quote: z.string().min(1).max(200),
  }),
});
export type IntakeField = z.infer<typeof IntakeField>;

/** Strict model response. Missing fields are computed by the server and are not model-authored. */
export const IntakeModelOutput = z.strictObject({
  fields: z.array(IntakeField),
  warnings: z.array(z.string()),
});
export type IntakeModelOutput = z.infer<typeof IntakeModelOutput>;

export const IntakeInput = z.strictObject({
  tenantId: z.string().min(1),
  caseDraftId: z.string().min(1),
  sourceText: z.string().trim().min(1).max(20_000),
  sourceAuthority: z.string().min(1).optional(),
  languageHint: z.string().min(1).optional(),
});
export type IntakeInput = z.infer<typeof IntakeInput>;

export const IntakeProposal = z.strictObject({
  fields: z.array(IntakeField),
  missing: z.array(IntakeFieldKey),
  warnings: z.array(z.string()),
  duplicateFingerprint: z.string().nullable(),
  meta: z.strictObject({
    modelId: z.string().min(1),
    promptVersion: z.string().min(1),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    synthetic: z.boolean(),
  }),
});
export type IntakeProposal = z.infer<typeof IntakeProposal>;
