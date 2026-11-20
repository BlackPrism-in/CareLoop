import { randomUUID } from 'node:crypto';
import {
  CoordinationContext,
  CoordinationSlot,
  CoordinationToolCall,
  type CoordinationToolCall as ToolCall,
} from '@careloop/contracts';

export type ToolResult =
  | { ok: true; tool: 'list_slots'; slots: CoordinationSlot[] }
  | { ok: true; tool: 'request_booking'; status: 'REQUESTED' }
  | { ok: true; tool: 'request_callback'; status: 'REQUESTED' }
  | { ok: true; tool: 'create_handoff'; status: 'CREATED' }
  | {
      ok: false;
      code:
        | 'OPT_OUT_STOPPED'
        | 'APPROVAL_STALE'
        | 'CONSENT_INACTIVE'
        | 'TOOL_BUDGET_EXHAUSTED'
        | 'REPLANNING_BUDGET_EXHAUSTED'
        | 'BOOKING_UNKNOWN'
        | 'IDENTITY_MISMATCH'
        | 'SLOT_NOT_LATESTLY_OFFERED'
        | 'SLOT_NOT_CONFIRMED'
        | 'SLOT_DOES_NOT_MATCH_PREFERENCES'
        | 'NO_SLOTS'
        | 'CONTACT_WINDOW_CLOSED'
        | 'CONTACT_BUDGET_EXHAUSTED'
        | 'VERSION_CONFLICT'
        | 'BOOKING_CONFLICT'
        | 'BOOKING_OUTCOME_UNKNOWN'
        | 'CALLBACK_OUTCOME_UNKNOWN'
        | 'HANDOFF_OUTCOME_UNKNOWN'
        | 'HANDOFF_ALREADY_OPEN'
        | 'INVALID_TOOL_CALL';
      detail?: string;
    };

export interface CoordinationActor {
  /** Built by authenticated server membership; never accepted from a model call. */
  tenantId: string;
  actorId: string;
  caseId: string;
  approvalRevision: number;
  correlationId: string;
}

export interface CommandEnvelope<I> {
  tenantId: string;
  actorId: string;
  caseId: string;
  expectedVersion: number;
  approvalRevision: number;
  idempotencyKey: string;
  correlationId: string;
  input: I;
}

export interface CoordinationCommandPort {
  requestBooking(
    req: CommandEnvelope<{ slotId: string; patientConfirmedSlot: true }>,
  ): Promise<'REQUESTED' | 'CONFLICT' | 'UNKNOWN'>;
  requestCallback(
    req: CommandEnvelope<{ from?: string; to?: string }>,
  ): Promise<'REQUESTED' | 'CONFLICT' | 'UNKNOWN'>;
  createHandoff(
    req: CommandEnvelope<{
      reasonCode: string;
      summary: string;
      ownerId: string;
      dueAt: string;
    }>,
  ): Promise<'CREATED' | 'ALREADY_OPEN'>;
}

export interface CoordinationBookingPort {
  listSlots(req: {
    tenantId: string;
    operationId: string;
    correlationId: string;
    siteId: string;
    actionType: CoordinationContext['actionType'];
    from: string;
    to: string;
  }): Promise<CoordinationSlot[]>;
}

export interface AuthoritativeCaseSnapshot {
  context: CoordinationContext;
  ownerId: string;
  handoffDueAt: string;
}

export interface CoordinationGatewayDeps {
  loadSnapshot(args: { tenantId: string; caseId: string }): Promise<AuthoritativeCaseSnapshot>;
  booking: CoordinationBookingPort;
  commands: CoordinationCommandPort;
  now?: () => Date;
  operationId?: () => string;
}

/**
 * Deterministic command gateway. Every tool gets a fresh server snapshot,
 * tenant scope and version. Model arguments never carry actor, tenant or version.
 */
export class CoordinationGateway {
  private readonly offered = new Map<string, Map<string, CoordinationSlot>>();
  private readonly usedOps = new Map<string, number>();

  constructor(private readonly deps: CoordinationGatewayDeps) {}

  async execute(actor: CoordinationActor, rawToolCall: unknown): Promise<ToolResult> {
    const parsed = CoordinationToolCall.safeParse(rawToolCall);
    if (!parsed.success) return { ok: false, code: 'INVALID_TOOL_CALL' };
    const scope = caseScope(actor.tenantId, actor.caseId);
    const operationCount = this.usedOps.get(scope) ?? 0;
    if (operationCount >= 3) return { ok: false, code: 'TOOL_BUDGET_EXHAUSTED' };
    // Reserve the final operation for a safe human handoff if the model exhausts its budget.
    if (parsed.data.name !== 'create_handoff' && operationCount >= 2)
      return { ok: false, code: 'TOOL_BUDGET_EXHAUSTED' };

    let snapshot: AuthoritativeCaseSnapshot;
    try {
      snapshot = await this.deps.loadSnapshot({ tenantId: actor.tenantId, caseId: actor.caseId });
    } catch (error) {
      return { ok: false, code: 'APPROVAL_STALE', detail: errorMessage(error) };
    }
    const c = CoordinationContext.safeParse(snapshot.context);
    if (!c.success || c.data.caseId !== actor.caseId) return { ok: false, code: 'APPROVAL_STALE' };
    const context = c.data;
    if (context.approvalRevision !== actor.approvalRevision || context.approvalRevision < 1)
      return { ok: false, code: 'APPROVAL_STALE' };
    if (context.optedOut) return { ok: false, code: 'OPT_OUT_STOPPED' };
    if (!context.consentActive) return { ok: false, code: 'CONSENT_INACTIVE' };

    const call = parsed.data;
    if (call.name === 'list_slots') return this.listSlots(actor, context, call);
    if (call.name === 'request_booking') return this.requestBooking(actor, snapshot, context, call);
    if (call.name === 'request_callback') return this.requestCallback(actor, snapshot, context, call);
    return this.createHandoff(actor, snapshot, context, call);
  }

  private opId(): string {
    return (this.deps.operationId ?? randomUUID)();
  }

  private commandEnvelope<I>(actor: CoordinationActor, c: CoordinationContext, operation: string, input: I): CommandEnvelope<I> {
    return {
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      caseId: actor.caseId,
      expectedVersion: c.expectedVersion,
      approvalRevision: c.approvalRevision,
      idempotencyKey: `coord-${actor.caseId}-${actor.correlationId}-${operation}`,
      correlationId: actor.correlationId,
      input,
    };
  }

  private async listSlots(actor: CoordinationActor, c: CoordinationContext, call: Extract<ToolCall, { name: 'list_slots' }>): Promise<ToolResult> {
    if (c.workflowState !== 'AWAITING_BOOKING') return { ok: false, code: 'APPROVAL_STALE' };
    if (c.bookingState === 'UNKNOWN') return { ok: false, code: 'BOOKING_UNKNOWN' };
    if (Date.parse(call.arguments.from) >= Date.parse(call.arguments.to))
      return { ok: false, code: 'INVALID_TOOL_CALL' };
    try {
      const operationId = this.opId();
      this.bump(actor);
      const raw = await this.deps.booking.listSlots({
        tenantId: actor.tenantId,
        operationId,
        correlationId: actor.correlationId,
        siteId: c.siteId,
        actionType: c.actionType,
        from: call.arguments.from,
        to: call.arguments.to,
      });
      const slots = raw.map((slot) => CoordinationSlot.parse(slot));
      // Replace, do not merge: only this latest adapter result may authorize booking.
      this.offered.set(caseScope(actor.tenantId, actor.caseId), new Map(slots.map((slot) => [slot.slotId, slot])));
      return { ok: true, tool: 'list_slots', slots };
    } catch (error) {
      return { ok: false, code: 'INVALID_TOOL_CALL', detail: errorMessage(error) };
    }
  }

  private async requestBooking(actor: CoordinationActor, snapshot: AuthoritativeCaseSnapshot, c: CoordinationContext, call: Extract<ToolCall, { name: 'request_booking' }>): Promise<ToolResult> {
    if (c.workflowState !== 'AWAITING_BOOKING' || c.bookingState === 'REQUESTED' || c.bookingState === 'CONFIRMED')
      return { ok: false, code: 'APPROVAL_STALE' };
    if (c.bookingState === 'UNKNOWN') return { ok: false, code: 'BOOKING_UNKNOWN' };
    if (!c.identityVerified) return { ok: false, code: 'IDENTITY_MISMATCH' };
    if (c.patientConfirmedSlotId !== call.arguments.slotId)
      return { ok: false, code: 'SLOT_NOT_CONFIRMED' };
    const offeredSlot = this.offered.get(caseScope(actor.tenantId, actor.caseId))?.get(call.arguments.slotId);
    if (!offeredSlot)
      return { ok: false, code: 'SLOT_NOT_LATESTLY_OFFERED' };
    if (!slotMatchesPreferences(offeredSlot, c)) return { ok: false, code: 'SLOT_DOES_NOT_MATCH_PREFERENCES' };
    try {
      // A thrown transport error can happen after the command reached its worker.
      // Count it and mark the outcome unknown; callers must reconcile, never retry.
      this.bump(actor);
      const result = await this.deps.commands.requestBooking(this.commandEnvelope(actor, c, 'request-booking', {
        slotId: call.arguments.slotId,
        patientConfirmedSlot: true as const,
      }));
      if (result === 'CONFLICT') return { ok: false, code: 'BOOKING_CONFLICT' };
      if (result === 'UNKNOWN') return { ok: false, code: 'BOOKING_OUTCOME_UNKNOWN' };
      return { ok: true, tool: 'request_booking', status: 'REQUESTED' };
    } catch (error) {
      return { ok: false, code: 'BOOKING_OUTCOME_UNKNOWN', detail: errorMessage(error) };
    }
  }

  private async requestCallback(actor: CoordinationActor, _snapshot: AuthoritativeCaseSnapshot, c: CoordinationContext, call: Extract<ToolCall, { name: 'request_callback' }>): Promise<ToolResult> {
    if (c.workflowState !== 'CONTACTING') return { ok: false, code: 'APPROVAL_STALE' };
    if (!c.identityVerified) return { ok: false, code: 'IDENTITY_MISMATCH' };
    if (!c.patientRequestedCallback) return { ok: false, code: 'INVALID_TOOL_CALL' };
    if (!c.contactWindowOpen) return { ok: false, code: 'CONTACT_WINDOW_CLOSED' };
    if (c.contactAttempts >= c.maxContactAttempts) return { ok: false, code: 'CONTACT_BUDGET_EXHAUSTED' };
    try {
      this.bump(actor);
      const result = await this.deps.commands.requestCallback(this.commandEnvelope(actor, c, 'request-callback', call.arguments));
      if (result === 'UNKNOWN') return { ok: false, code: 'CALLBACK_OUTCOME_UNKNOWN' };
      return result === 'REQUESTED'
        ? { ok: true, tool: 'request_callback', status: 'REQUESTED' }
        : { ok: false, code: 'VERSION_CONFLICT' };
    } catch (error) {
      return { ok: false, code: 'CALLBACK_OUTCOME_UNKNOWN', detail: errorMessage(error) };
    }
  }

  private async createHandoff(actor: CoordinationActor, snapshot: AuthoritativeCaseSnapshot, c: CoordinationContext, call: Extract<ToolCall, { name: 'create_handoff' }>): Promise<ToolResult> {
    if (c.handoffState === 'PENDING' || c.handoffState === 'ACKNOWLEDGED')
      return { ok: false, code: 'HANDOFF_ALREADY_OPEN' };
    try {
      this.bump(actor);
      const result = await this.deps.commands.createHandoff(this.commandEnvelope(actor, c, 'create-handoff', {
        reasonCode: call.arguments.reasonCode,
        summary: call.arguments.summary,
        ownerId: snapshot.ownerId,
        dueAt: snapshot.handoffDueAt,
      }));
      return result === 'CREATED'
        ? { ok: true, tool: 'create_handoff', status: 'CREATED' }
        : { ok: false, code: 'HANDOFF_ALREADY_OPEN' };
    } catch (error) {
      return { ok: false, code: 'HANDOFF_OUTCOME_UNKNOWN', detail: errorMessage(error) };
    }
  }

  private bump(actor: CoordinationActor) {
    const scope = caseScope(actor.tenantId, actor.caseId);
    this.usedOps.set(scope, (this.usedOps.get(scope) ?? 0) + 1);
  }
}

function caseScope(tenantId: string, caseId: string): string {
  return `${tenantId}:${caseId}`;
}

function slotMatchesPreferences(slot: CoordinationSlot, context: CoordinationContext): boolean {
  const start = new Date(slot.startsAt);
  let localParts: Intl.DateTimeFormatPart[];
  try {
    localParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: context.timeZone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(start);
  } catch {
    return false;
  }
  const parts = Object.fromEntries(localParts.map((part) => [part.type, part.value]));
  const dateParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: context.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(start);
  const dateMap = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  const weekday = String(parts.weekday ?? '').toUpperCase();
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const day = `${dateMap.year}-${dateMap.month}-${dateMap.day}`;
  const pref = context.preferences;

  if (pref.preferredDays.length && !pref.preferredDays.includes(weekday as (typeof pref.preferredDays)[number])) return false;
  if (pref.earliestDate && day < pref.earliestDate) return false;
  if (pref.latestDate && day > pref.latestDate) return false;
  if (pref.avoidWorkHours && time >= '09:00' && time < '17:00') return false;

  const period = hour < 12 ? 'MORNING' : hour < 17 ? 'AFTERNOON' : 'EVENING';
  if (pref.unavailableTimePeriods.includes(period)) return false;
  const preferred = pref.preferredTimePeriods.filter((p) => p !== 'ANY');
  if (preferred.length && !preferred.includes(period)) return false;
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 180) : 'gateway error';
}
