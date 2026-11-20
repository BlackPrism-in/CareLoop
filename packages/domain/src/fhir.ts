import type { Case, EventEnvelope } from '@careloop/contracts';
import { verifyChain } from './event-chain';

/**
 * FHIR R4 export of one follow-up (Phase 9, hospital/LIMS integration).
 *
 * Minimum necessary: the Patient resource carries only CareLoop's internal
 * identifier and the lab's external reference, no name, phone or birth date.
 * The receiving system joins on the identifier it already holds.
 *
 * Mapping:
 *  - ServiceRequest: the clinician-ordered action (consultation or test) and its due date.
 *  - Task: CareLoop's coordination of that request; status follows the workflow.
 *  - Appointment: each booking with a confirmed or cancelled outcome.
 *  - Provenance: who changed the case and when, plus the event-chain head hash.
 */

export interface FhirBookingInput {
  bookingId: string;
  status: string;
  startsAt: string | null;
  location: string | null;
  externalRef: string | null;
  simulation: boolean;
}

export interface FhirExportInput {
  tenantId: string;
  case: Case;
  patientExternalRef: string | null;
  events: EventEnvelope[];
  bookings: FhirBookingInput[];
  generatedAt: string;
}

type Resource = { resourceType: string; id: string } & Record<string, unknown>;

const SYS = 'https://careloop.example/fhir';

const TASK_STATUS: Record<Case['workflowState'], string> = {
  DRAFT: 'draft',
  READY: 'ready',
  CONTACTING: 'in-progress',
  AWAITING_BOOKING: 'in-progress',
  BOOKED: 'in-progress',
  AWAITING_EVIDENCE: 'in-progress',
  COMPLETED_VERIFIED: 'completed',
  CANCELLED: 'cancelled',
};

const REQUEST_STATUS: Record<Case['workflowState'], string> = {
  DRAFT: 'draft',
  READY: 'active',
  CONTACTING: 'active',
  AWAITING_BOOKING: 'active',
  BOOKED: 'active',
  AWAITING_EVIDENCE: 'active',
  COMPLETED_VERIFIED: 'completed',
  CANCELLED: 'revoked',
};

function appointmentStatus(s: string): string | null {
  if (s === 'CONFIRMED' || s === 'CANCEL_PENDING') return 'booked';
  if (s === 'CANCELLED') return 'cancelled';
  return null; // requested/unknown/rejected bookings are not appointments
}

/** FHIR ids allow [A-Za-z0-9-.]{1,64}. */
const fid = (s: string) => s.replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 64);

export function buildFhirBundle(input: FhirExportInput): Resource {
  const c = input.case;
  const patientId = fid(`pat-${c.patientId}`);
  const requestId = fid(`sr-${c.caseId}`);
  const taskId = fid(`task-${c.caseId}`);
  const ref = (type: string, id: string) => ({ reference: `${type}/${id}` });
  const simulationTag = input.events.some((e) => e.simulation)
    ? [{ system: `${SYS}/tags`, code: 'simulation', display: 'Synthetic or sandbox data' }]
    : [];
  const meta = simulationTag.length ? { tag: simulationTag } : undefined;

  const patient: Resource = {
    resourceType: 'Patient',
    id: patientId,
    ...(meta ? { meta } : {}),
    identifier: [
      { system: `${SYS}/${input.tenantId}/patient`, value: c.patientId },
      ...(input.patientExternalRef
        ? [{ system: `${SYS}/${input.tenantId}/lab-ref`, value: input.patientExternalRef }]
        : []),
    ],
  };

  const serviceRequest: Resource = {
    resourceType: 'ServiceRequest',
    id: requestId,
    ...(meta ? { meta } : {}),
    identifier: [{ system: `${SYS}/${input.tenantId}/case`, value: c.caseId }],
    status: REQUEST_STATUS[c.workflowState],
    intent: 'order',
    category: [
      {
        coding: [
          c.actionType === 'ORDERED_TEST'
            ? { system: 'http://snomed.info/sct', code: '108252007', display: 'Laboratory procedure' }
            : { system: 'http://snomed.info/sct', code: '11429006', display: 'Consultation' },
        ],
      },
    ],
    code: { text: c.actionText },
    subject: ref('Patient', patientId),
    occurrenceDateTime: c.dueAt,
    authoredOn: c.createdAt,
  };

  const task: Resource = {
    resourceType: 'Task',
    id: taskId,
    ...(meta ? { meta } : {}),
    identifier: [{ system: `${SYS}/${input.tenantId}/case`, value: c.caseId }],
    status: TASK_STATUS[c.workflowState],
    businessStatus: { text: c.workflowState },
    intent: 'order',
    focus: ref('ServiceRequest', requestId),
    for: ref('Patient', patientId),
    authoredOn: c.createdAt,
    lastModified: c.updatedAt,
    restriction: { period: { end: c.dueAt } },
  };

  const appointments: Resource[] = input.bookings.flatMap((b) => {
    const status = appointmentStatus(b.status);
    if (!status) return [];
    return [
      {
        resourceType: 'Appointment',
        id: fid(`appt-${b.bookingId}`),
        ...(b.simulation ? { meta: { tag: [{ system: `${SYS}/tags`, code: 'simulation' }] } } : {}),
        ...(b.externalRef ? { identifier: [{ system: `${SYS}/${input.tenantId}/booking`, value: b.externalRef }] } : {}),
        status,
        basedOn: [ref('ServiceRequest', requestId)],
        ...(b.startsAt ? { start: b.startsAt } : {}),
        ...(b.location ? { description: b.location } : {}),
        participant: [{ actor: ref('Patient', patientId), status: 'accepted' }],
      },
    ];
  });

  const chain = verifyChain(input.events, c.lastEventHash);
  const agents = [...new Map(input.events.map((e) => [`${e.actorType}:${e.actorId}`, e])).values()];
  const provenance: Resource = {
    resourceType: 'Provenance',
    id: fid(`prov-${c.caseId}-v${c.version}`),
    target: [ref('Task', taskId), ref('ServiceRequest', requestId), ...appointments.map((a) => ref('Appointment', a.id))],
    recorded: input.generatedAt,
    agent: agents.map((e) => ({
      type: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: e.actorType === 'STAFF' ? 'author' : 'assembler' }],
      },
      who: { display: `${e.actorType.toLowerCase()}:${e.actorId}` },
    })),
    entity: [
      {
        role: 'source',
        what: {
          identifier: { system: `${SYS}/${input.tenantId}/event-chain`, value: c.lastEventHash ?? 'unchained' },
          display: `Case event history v1–v${c.version}; chain ${chain.ok ? 'verified' : `FAILED (${chain.reason})`}`,
        },
      },
    ],
  };

  const resources = [patient, serviceRequest, task, ...appointments, provenance];
  return {
    resourceType: 'Bundle',
    id: fid(`careloop-${c.caseId}-v${c.version}`),
    type: 'collection',
    timestamp: input.generatedAt,
    // RESTful fullUrls, so the relative references inside resolve within the bundle.
    entry: resources.map((r) => ({ fullUrl: `${SYS}/${input.tenantId}/${r.resourceType}/${r.id}`, resource: r })),
  };
}
