import type { CoordinationContext, CoordinationSlot } from '@careloop/contracts';
import type {
  AuthoritativeCaseSnapshot,
  CommandEnvelope,
  CoordinationActor,
  CoordinationBookingPort,
  CoordinationCommandPort,
  CoordinationGatewayDeps,
} from './gateway';

export interface MemoryCoordinationCase extends CoordinationContext {
  tenantId: string;
  ownerId: string;
  handoffDueAt: string;
  reservations: Set<string>;
  callbackRequested: boolean;
  handoffSummary?: string;
}

export interface MemorySlot extends CoordinationSlot {
  tenantId: string;
  siteId: string;
  actionType: CoordinationContext['actionType'];
}

/** In-memory sandbox ports for deterministic agent development; never production storage. */
export class InMemoryCoordinationWorld implements CoordinationBookingPort, CoordinationCommandPort {
  private readonly cases = new Map<string, MemoryCoordinationCase>();
  private readonly slots: MemorySlot[] = [];
  private readonly outcomes = new Map<string, 'REQUESTED' | 'CONFLICT' | 'UNKNOWN' | 'CREATED' | 'ALREADY_OPEN'>();

  addCase(input: Omit<MemoryCoordinationCase, 'reservations' | 'callbackRequested'>): void {
    this.cases.set(key(input.tenantId, input.caseId), {
      ...input,
      reservations: new Set(),
      callbackRequested: false,
    });
  }

  addSlots(slots: MemorySlot[]): void {
    this.slots.push(...slots.map((slot) => ({ ...slot })));
  }

  deps(): CoordinationGatewayDeps {
    return {
      loadSnapshot: ({ tenantId, caseId }) => this.loadSnapshot({ tenantId, caseId }),
      booking: this,
      commands: this,
    };
  }

  async loadSnapshot(args: { tenantId: string; caseId: string }): Promise<AuthoritativeCaseSnapshot> {
    const current = this.requireCase(args.tenantId, args.caseId);
    const { tenantId: _tenant, ownerId, handoffDueAt, reservations: _r, callbackRequested: _c, handoffSummary: _h, ...context } = current;
    return { context: structuredClone(context), ownerId, handoffDueAt };
  }

  async listSlots(req: Parameters<CoordinationBookingPort['listSlots']>[0]): Promise<CoordinationSlot[]> {
    const from = Date.parse(req.from);
    const to = Date.parse(req.to);
    return this.slots.filter((slot) => {
      const starts = Date.parse(slot.startsAt);
      return starts >= from && starts <= to && slot.tenantId === req.tenantId && slot.siteId === req.siteId && slot.actionType === req.actionType && !this.isReserved(req.tenantId, slot.slotId);
    }).map((slot) => ({ ...slot }));
  }

  async requestBooking(req: CommandEnvelope<{ slotId: string; patientConfirmedSlot: true }>): Promise<'REQUESTED' | 'CONFLICT' | 'UNKNOWN'> {
    const prior = this.outcomes.get(req.idempotencyKey);
    if (prior === 'REQUESTED' || prior === 'CONFLICT' || prior === 'UNKNOWN') return prior;
    const c = this.requireCase(req.tenantId, req.caseId);
    this.checkVersion(c, req.expectedVersion, req.approvalRevision);
    if (!req.input.patientConfirmedSlot || !this.slots.some((slot) => slot.slotId === req.input.slotId))
      throw new Error('SLOT_NOT_CONFIRMED_OR_INVENTED');
    if (this.isReserved(req.tenantId, req.input.slotId)) {
      this.outcomes.set(req.idempotencyKey, 'CONFLICT');
      return 'CONFLICT';
    }
    if (req.input.slotId === 'slot_fake_timeout') {
      c.bookingState = 'UNKNOWN';
      c.expectedVersion++;
      this.outcomes.set(req.idempotencyKey, 'UNKNOWN');
      return 'UNKNOWN';
    }
    c.bookingState = 'REQUESTED';
    c.expectedVersion++;
    c.reservations.add(req.input.slotId);
    this.outcomes.set(req.idempotencyKey, 'REQUESTED');
    return 'REQUESTED';
  }

  async requestCallback(req: CommandEnvelope<{ from?: string; to?: string }>): Promise<'REQUESTED' | 'CONFLICT'> {
    const prior = this.outcomes.get(req.idempotencyKey);
    if (prior === 'REQUESTED' || prior === 'CONFLICT') return prior;
    const c = this.requireCase(req.tenantId, req.caseId);
    this.checkVersion(c, req.expectedVersion, req.approvalRevision);
    c.callbackRequested = true;
    c.contactAttempts++;
    c.expectedVersion++;
    this.outcomes.set(req.idempotencyKey, 'REQUESTED');
    return 'REQUESTED';
  }

  async createHandoff(req: CommandEnvelope<{ reasonCode: string; summary: string; ownerId: string; dueAt: string }>): Promise<'CREATED' | 'ALREADY_OPEN'> {
    const prior = this.outcomes.get(req.idempotencyKey);
    if (prior === 'CREATED' || prior === 'ALREADY_OPEN') return prior;
    const c = this.requireCase(req.tenantId, req.caseId);
    this.checkVersion(c, req.expectedVersion, req.approvalRevision);
    if (c.handoffState === 'PENDING' || c.handoffState === 'ACKNOWLEDGED') {
      this.outcomes.set(req.idempotencyKey, 'ALREADY_OPEN');
      return 'ALREADY_OPEN';
    }
    c.handoffState = 'PENDING';
    c.expectedVersion++;
    c.handoffSummary = `${req.input.reasonCode}: ${req.input.summary}`;
    this.outcomes.set(req.idempotencyKey, 'CREATED');
    return 'CREATED';
  }

  setOptOut(tenantId: string, caseId: string): void {
    const c = this.requireCase(tenantId, caseId);
    c.optedOut = true;
    c.consentActive = false;
    c.expectedVersion++;
  }

  setIdentityVerified(tenantId: string, caseId: string, verified: boolean): void {
    const c = this.requireCase(tenantId, caseId);
    c.identityVerified = verified;
    c.expectedVersion++;
  }

  takeSlot(tenantId: string, caseId: string, slotId: string): void {
    const c = this.requireCase(tenantId, caseId);
    c.reservations.add(slotId);
  }

  setBookingUnknown(tenantId: string, caseId: string): void {
    const c = this.requireCase(tenantId, caseId);
    c.bookingState = 'UNKNOWN';
    c.expectedVersion++;
  }

  state(tenantId: string, caseId: string): Readonly<MemoryCoordinationCase> {
    return structuredClone(this.requireCase(tenantId, caseId));
  }

  private requireCase(tenantId: string, caseId: string): MemoryCoordinationCase {
    const c = this.cases.get(key(tenantId, caseId));
    if (!c) throw new Error('CASE_NOT_FOUND_OR_TENANT_MISMATCH');
    return c;
  }

  private checkVersion(c: MemoryCoordinationCase, expectedVersion: number, approvalRevision: number) {
    if (c.expectedVersion !== expectedVersion) throw new Error('VERSION_CONFLICT');
    if (c.approvalRevision !== approvalRevision) throw new Error('APPROVAL_REVISION_CONFLICT');
    if (!c.consentActive || c.optedOut) throw new Error('CONSENT_INACTIVE');
  }

  private isReserved(tenantId: string, slotId: string): boolean {
    return [...this.cases.values()].some((c) => c.tenantId === tenantId && c.reservations.has(slotId));
  }
}

export function actorForMemoryCase(
  tenantId: string,
  actorId: string,
  caseId: string,
  approvalRevision: number,
): CoordinationActor {
  return { tenantId, actorId, caseId, approvalRevision, correlationId: `coord-${caseId}` };
}

function key(tenantId: string, caseId: string): string {
  return `${tenantId}:${caseId}`;
}
