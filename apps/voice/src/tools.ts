import type { FunctionDecl } from './live';

/** The only actions the conversation agent can request. Each is validated and executed by the gateway. */
export const TOOLS: FunctionDecl[] = [
  {
    name: 'find_slots',
    description:
      'Look up available appointment times that match what the patient said. Only call after identity is verified.',
    parameters: {
      type: 'object',
      properties: {
        preference: {
          type: 'string',
          description: "The patient's stated timing preference, in their words.",
        },
      },
      required: ['preference'],
    },
  },
  {
    name: 'request_booking',
    description:
      'Request one of the times returned by find_slots, after reading back date, time and place and hearing a clear yes.',
    parameters: {
      type: 'object',
      properties: {
        slot_id: { type: 'string' },
        patient_confirmed: {
          type: 'boolean',
          description: 'True only if the patient clearly said yes to the read-back.',
        },
      },
      required: ['slot_id', 'patient_confirmed'],
    },
  },
  {
    name: 'request_callback',
    description: 'The patient wants a person from the lab to call them back.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: [] },
  },
  {
    name: 'route_to_staff',
    description:
      'Hand the case to lab staff. Use MEDICAL_QUESTION for any question about results, symptoms, medicines or seriousness.',
    parameters: {
      type: 'object',
      properties: {
        reason_code: {
          type: 'string',
          enum: ['MEDICAL_QUESTION', 'PATIENT_REQUESTED_HUMAN', 'NOT_THE_PATIENT', 'OTHER'],
        },
      },
      required: ['reason_code'],
    },
  },
  {
    name: 'record_opt_out',
    description: 'The patient does not want further automated contact.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'end_call',
    description: 'End the call after saying goodbye.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: [] },
  },
];
