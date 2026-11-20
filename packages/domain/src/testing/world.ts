import type {
  Consent,
  Member,
  Patient,
  Site,
  Source,
  StaffRole,
  Tenant,
} from '@careloop/contracts';
import type { ActorContext } from '../context';
import { tenantDoc, tenantRecord } from '../paths';
import { CaseCommands, type CreateCaseInput, type ServiceConfig } from '../service';

export const T1 = 't_test';
export const T2 = 't_other';

/** 10:30 IST on 21 Nov 2026 — inside the 09:00–19:00 contact window. */
export const START = new Date('2026-11-21T05:00:00Z');

export function staff(uid: string, ...roles: StaffRole[]): ActorContext {
  return { tenantId: T1, actorType: 'STAFF', actorId: uid, roles, correlationId: `corr-${uid}` };
}
export const SYSTEM: ActorContext = {
  tenantId: T1,
  actorType: 'SYSTEM',
  actorId: 'worker',
  roles: [],
  correlationId: 'corr-sys',
};
export const AGENT: ActorContext = {
  tenantId: T1,
  actorType: 'AGENT',
  actorId: 'agent-coord',
  roles: [],
  correlationId: 'corr-agent',
};

export const coordinator = staff('u_coord', 'COORDINATOR');
export const reviewer = staff('u_rev', 'REVIEWER');
export const verifier = staff('u_ver', 'VERIFIER');
export const owner = staff('u_owner', 'OWNER');
export const auditor = staff('u_aud', 'AUDITOR');

const tenant = (tenantId: string): Tenant => ({
  tenantId,
  displayName: tenantId,
  timeZone: 'Asia/Kolkata',
  outreachPaused: false,
  simulation: true,
});
const site: Site = {
  siteId: 'site_1',
  displayName: 'Site',
  timeZone: 'Asia/Kolkata',
  contactWindow: { start: '09:00', end: '19:00' },
};
const member = (uid: string, roles: StaffRole[]): Member => ({
  uid,
  displayName: uid,
  email: `${uid}@test.careloop.test`,
  roleSet: roles,
  status: 'ACTIVE',
  permittedSiteIds: ['site_1'],
});
export const patient = (patientId: string, over: Partial<Patient> = {}): Patient => ({
  patientId,
  externalRef: `ref_${patientId}`,
  alias: 'Patient',
  contactMasked: '+91 ••• 00',
  ageEligibility: 'ADULT_CONFIRMED',
  language: 'hi-IN',
  identityMethodRef: 'supervised_demo',
  ...over,
});
export const consent = (
  consentId: string,
  patientId: string,
  over: Partial<Consent> = {},
): Consent => ({
  consentId,
  patientId,
  purpose: 'FOLLOW_UP_COORDINATION',
  channels: ['BROWSER_VOICE'],
  noticeVersion: 'v1',
  recordedBy: 'u_coord',
  proofRef: 'proof',
  grantedAt: '2026-11-20T00:00:00Z',
  revokedAt: null,
  expiresAt: null,
  version: 1,
  ...over,
});
const source = (sourceId: string, reference: string): Source => ({
  sourceId,
  sourceAuthority: 'clinic',
  documentType: 'FORM',
  reference,
});

/** Seeds two tenants so cross-tenant references can be tested. */
export async function seedWorld(store: { seed(path: string, data: object): unknown }) {
  const pending: unknown[] = [];
  const put = (path: string, data: object) => pending.push(store.seed(path, data));
  for (const t of [T1, T2]) {
    put(tenantDoc(t), tenant(t));
    put(tenantRecord(t, 'sites', 'site_1'), site);
  }
  for (const [uid, roles] of [
    ['u_coord', ['COORDINATOR']],
    ['u_rev', ['REVIEWER']],
    ['u_ver', ['VERIFIER']],
    ['u_owner', ['OWNER']],
    ['u_aud', ['AUDITOR']],
  ] as const) {
    put(tenantRecord(T1, 'members', uid), member(uid, [...roles]));
  }
  put(tenantRecord(T1, 'patients', 'p1'), patient('p1'));
  put(tenantRecord(T1, 'consents', 'c1'), consent('c1', 'p1'));
  put(tenantRecord(T1, 'patients', 'p_minor'), patient('p_minor', { ageEligibility: 'UNKNOWN' }));
  put(tenantRecord(T1, 'consents', 'c_minor'), consent('c_minor', 'p_minor'));
  for (let i = 1; i <= 5; i++)
    put(tenantRecord(T1, 'sources', `s${i}`), source(`s${i}`, `ORD-${i}`));
  // Only exists in the other tenant.
  put(tenantRecord(T2, 'patients', 'p_other'), patient('p_other'));
  put(tenantRecord(T2, 'consents', 'c_other'), consent('c_other', 'p_other'));
  await Promise.all(pending);
}

export const DEFAULT_CONFIG: ServiceConfig = {
  outreachEnabled: true,
  maxContactAttempts: 2,
  maxCaseAudioSeconds: 180,
};

export function newCase(over: Partial<CreateCaseInput> = {}): CreateCaseInput {
  return {
    caseId: 'CL-1',
    siteId: 'site_1',
    patientId: 'p1',
    sourceId: 's1',
    consentId: 'c1',
    actionType: 'CONSULTATION',
    actionText: 'Arrange the approved clinic consultation',
    dueAt: '2026-11-28T12:30:00Z',
    ownerId: 'u_coord',
    language: 'hi-IN',
    ...over,
  };
}

export const ALL_CHECKS = [
  'patient',
  'action',
  'dueAt',
  'contact',
  'owner',
  'language',
  'adult',
] as const;

/** Drives a case to a given milestone through real commands. */
export class Driver {
  version = 1;
  private n = 0;
  constructor(
    readonly svc: CaseCommands,
    readonly caseId = 'CL-1',
  ) {}
  key(label: string) {
    return `${this.caseId}-${label}-${++this.n}`;
  }
  req<I>(input: I, label = 'cmd') {
    return {
      caseId: this.caseId,
      expectedVersion: this.version,
      idempotencyKey: this.key(label),
      input,
    };
  }
  track<R extends { version: number }>(r: R): R {
    this.version = r.version;
    return r;
  }
  async create(over: Partial<CreateCaseInput> = {}) {
    return this.track(
      await this.svc.createCase(coordinator, {
        idempotencyKey: this.key('create'),
        input: newCase({ caseId: this.caseId, ...over }),
      }),
    );
  }
  async approve() {
    return this.track(
      await this.svc.approve(
        reviewer,
        this.req({ sourceAuthorityRef: 'order_1', checkedFields: [...ALL_CHECKS] }),
      ),
    );
  }
  async dispatch() {
    return this.track(
      await this.svc.dispatchContact(SYSTEM, this.req({ channel: 'BROWSER_VOICE' as const })),
    );
  }
  async patientBooks() {
    return this.track(
      await this.svc.recordPatientRequest(
        AGENT,
        this.req({
          interactionId: 'i1',
          identityAssurance: 'SIMULATED' as const,
          request: 'BOOK' as const,
        }),
      ),
    );
  }
  async requestBooking(slotId = 'slot_1') {
    return this.track(
      await this.svc.requestBooking(AGENT, this.req({ slotId, patientConfirmedSlot: true })),
    );
  }
  async confirmBooking(startsAt = '2026-11-23T11:00:00Z') {
    return this.track(
      await this.svc.confirmBooking(
        SYSTEM,
        this.req({
          externalRef: 'booking_1',
          startsAt,
          adapter: 'sandbox' as const,
          simulation: true,
        }),
      ),
    );
  }
  async toBooked() {
    await this.create();
    await this.approve();
    await this.dispatch();
    await this.patientBooks();
    await this.requestBooking();
    return this.confirmBooking();
  }
}
