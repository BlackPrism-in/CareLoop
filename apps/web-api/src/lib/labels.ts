/** Plain-language labels for stable reason codes shown to staff. */
export const REASON: Record<string, string> = {
  PATIENT_REF_MISMATCH: 'Different patient reference',
  PATIENT_REF_MISSING: 'No patient reference',
  OBLIGATION_MISMATCH: 'Different kind of follow-up',
  OCCURRENCE_IN_FUTURE: 'Dated in the future',
  OCCURRED_BEFORE_APPROVAL: 'Happened before this follow-up was approved',
  INVALID_OCCURRENCE_TIME: 'Unreadable date',
  SOURCE_REQUIRED: 'No source given',
  NO_CURRENT_APPROVAL: 'The case has no current approval',
  BOOKING_REF_MISMATCH: 'Different booking reference — needs a person',
  AWAITING_ATTESTATION: 'Waiting for a verifier',
  DETERMINISTIC_MATCH: 'Matched automatically (signed calendar event)',
  MEDICAL_QUESTION: 'Medical question — needs a clinician-led call back',
  CALLBACK_REQUESTED: 'Patient asked for a call back',
  PATIENT_REQUESTED_CHANGE: 'Patient asked to change the time',
  PATIENT_REQUESTED_HUMAN: 'Patient asked for a person',
  NOT_THE_PATIENT: 'Someone other than the patient answered',
  TOOL_BUDGET_EXCEEDED: 'Call needed more help than the assistant could give',
  NO_SUITABLE_SLOT: 'No suitable time available',
  CONTACT_UNREACHABLE: 'Patient could not be reached',
  CONTACT_DECLINED: 'Patient declined',
  REASSIGNED: 'Reassigned',
};
export const reason = (code: string | null | undefined) =>
  code ? (REASON[code] ?? code.toLowerCase().replaceAll('_', ' ')) : '';
