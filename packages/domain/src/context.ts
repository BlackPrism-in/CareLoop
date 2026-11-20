import type { ActorType, StaffRole } from '@careloop/contracts';
import { forbidden } from './errors';

/**
 * Who is issuing a command. Built server-side from the verified session and
 * tenant membership (staff), the queue identity (system), the voice/patient
 * session (agent/patient) or the provider account mapping (provider).
 * Never built from a request body.
 */
export interface ActorContext {
  tenantId: string;
  actorType: ActorType;
  actorId: string;
  /** Staff roles from membership; empty for non-staff actors. */
  roles: readonly StaffRole[];
  correlationId: string;
  /**
   * Sites this actor may act on. Undefined or 'ALL' = every site (owners,
   * auditors, system and agent actors). Staff with a site list only see and
   * change cases at those sites; anything else looks like it doesn't exist.
   */
  siteIds?: readonly string[] | 'ALL';
}

export function canAccessSite(ctx: Pick<ActorContext, 'siteIds'>, siteId: string): boolean {
  return ctx.siteIds === undefined || ctx.siteIds === 'ALL' || ctx.siteIds.includes(siteId);
}

/** Owners and auditors see every site; other staff only their permitted sites. */
export function siteScopeFor(
  roles: readonly StaffRole[],
  permittedSiteIds: readonly string[],
): readonly string[] | 'ALL' {
  return roles.some((r) => r === 'OWNER' || r === 'AUDITOR') ? 'ALL' : permittedSiteIds;
}

export type CommandName =
  | 'createCase'
  | 'editDraft'
  | 'approve'
  | 'dispatchContact'
  | 'recordContactOutcome'
  | 'recordInteractionEnded'
  | 'recordPatientRequest'
  | 'requestBooking'
  | 'confirmBooking'
  | 'markBookingUnknown'
  | 'recordBookingCancelled'
  | 'recordBookingRejected'
  | 'requestBookingCancellation'
  | 'awaitEvidence'
  | 'recordSelfReport'
  | 'recordEvidenceReview'
  | 'verifyCompletion'
  | 'optOut'
  | 'createHandoff'
  | 'acknowledgeHandoff'
  | 'resolveHandoff'
  | 'cancelCase'
  | 'reopenCase'
  | 'reassignHandoff'
  | 'recordProviderEvidence'
  | 'recordStaffEvidence'
  | 'attestEvidence';

interface Rule {
  roles: readonly StaffRole[];
  actors: readonly ActorType[];
}

const staff = (...roles: StaffRole[]): Rule => ({ roles, actors: ['STAFF'] });
const plus = (rule: Rule, ...actors: ActorType[]): Rule => ({
  roles: rule.roles,
  actors: [...rule.actors, ...actors],
});

/**
 * Command permissions (MVP spec §03). Notes:
 * - Only REVIEWER approves; OWNER cannot bypass clinical approval without the reviewer role.
 * - AUDITOR has no write commands at all.
 * - Staff attestation of completion is VERIFIER-only; a trusted provider event arrives as PROVIDER/SYSTEM.
 * - Agents act only through the command gateway and never approve, cancel, verify or reopen.
 */
export const PERMISSIONS: Record<CommandName, Rule> = {
  // SYSTEM: signed LIMS/hospital order intake. A new case is always a DRAFT needing reviewer approval.
  createCase: plus(staff('COORDINATOR', 'REVIEWER'), 'SYSTEM'),
  editDraft: staff('COORDINATOR', 'REVIEWER'),
  approve: staff('REVIEWER'),
  dispatchContact: plus(staff('COORDINATOR'), 'SYSTEM'),
  recordContactOutcome: plus(staff('COORDINATOR'), 'SYSTEM', 'AGENT'),
  recordInteractionEnded: plus(staff('COORDINATOR'), 'SYSTEM', 'AGENT'),
  recordPatientRequest: plus(staff('COORDINATOR'), 'AGENT', 'PATIENT'),
  requestBooking: plus(staff('COORDINATOR'), 'AGENT', 'PATIENT'),
  confirmBooking: plus(staff('COORDINATOR'), 'SYSTEM', 'PROVIDER'),
  markBookingUnknown: { roles: [], actors: ['SYSTEM'] },
  recordBookingCancelled: plus(staff('COORDINATOR'), 'SYSTEM', 'PROVIDER'),
  recordBookingRejected: plus(staff('COORDINATOR'), 'SYSTEM', 'PROVIDER'),
  requestBookingCancellation: plus(staff('COORDINATOR'), 'PATIENT'),
  awaitEvidence: plus(staff('COORDINATOR', 'VERIFIER'), 'SYSTEM', 'PROVIDER'),
  recordSelfReport: plus(staff('COORDINATOR'), 'AGENT', 'PATIENT'),
  recordEvidenceReview: plus(staff('VERIFIER'), 'SYSTEM'),
  verifyCompletion: plus(staff('VERIFIER'), 'SYSTEM'),
  optOut: plus(staff('COORDINATOR', 'REVIEWER', 'OWNER'), 'AGENT', 'PATIENT', 'SYSTEM'),
  createHandoff: plus(staff('COORDINATOR', 'REVIEWER', 'VERIFIER'), 'AGENT', 'SYSTEM', 'PATIENT'),
  acknowledgeHandoff: staff('COORDINATOR', 'REVIEWER', 'VERIFIER', 'OWNER'),
  resolveHandoff: staff('COORDINATOR', 'REVIEWER', 'VERIFIER', 'OWNER'),
  cancelCase: staff('REVIEWER', 'OWNER'),
  reopenCase: staff('REVIEWER', 'VERIFIER', 'OWNER'),
  reassignHandoff: staff('REVIEWER', 'OWNER'),
  recordProviderEvidence: { roles: [], actors: ['SYSTEM', 'PROVIDER'] },
  recordStaffEvidence: staff('VERIFIER', 'COORDINATOR'),
  attestEvidence: staff('VERIFIER'),
};

export function assertPermitted(ctx: ActorContext, command: CommandName): void {
  const rule = PERMISSIONS[command];
  if (!rule.actors.includes(ctx.actorType)) throw forbidden(`${ctx.actorType}_CANNOT_${command}`);
  if (ctx.actorType === 'STAFF' && !ctx.roles.some((r) => rule.roles.includes(r))) {
    throw forbidden(`ROLE_CANNOT_${command}`);
  }
}
