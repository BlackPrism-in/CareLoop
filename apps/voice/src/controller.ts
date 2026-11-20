import type { Firestore } from 'firebase-admin/firestore';
import type { Case } from '@careloop/contracts';
import type { BookingAdapter } from '@careloop/adapters';
import { coordinate, type JsonModel, type OfferedSlot } from '@careloop/ai';
import {
  DomainError,
  tenantRecord,
  type ActorContext,
  type CaseCommands,
  type CommandResult,
  type ContactOutcome,
} from '@careloop/domain';
import type { OutboxDispatcher } from '@careloop/jobs';
import type { Logger } from '@careloop/observability';
import type { LiveConnector, LiveSession, ToolCall } from './live';
import { claimsBooked, looksLikeMedicalQuestion } from './safety';
import { TOOLS } from './tools';

/** Messages to the browser. Transcripts are shown live and never stored. */
export type ServerMessage =
  | { type: 'ready'; capSeconds: number; simulation: boolean }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'interrupted' }
  | { type: 'transcript'; who: 'patient' | 'agent'; text: string }
  | { type: 'event'; kind: string; detail: string }
  | { type: 'ended'; reason: string; disposition: string; audioSeconds: number }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'audio'; data: string }
  | { type: 'text'; text: string }
  | { type: 'identity_verified' }
  | { type: 'end' };

export interface SessionInfo {
  tenantId: string;
  caseId: string;
  interactionId: string;
  createdBy: string;
  correlationId: string;
  simulation: boolean;
  labName: string;
  siteTimeZone: string;
}

export interface ControllerDeps {
  db: Firestore;
  commands: CaseCommands;
  booking: BookingAdapter;
  dispatcher: OutboxDispatcher;
  live: LiveConnector;
  coordinationModel: JsonModel | null;
  models: { live: string; coordination: string };
  promptVersions: { conversation: string; coordination: string };
  system: string;
  capSeconds: number;
  log: Logger;
  clock?: () => Date;
  /** How long request_booking waits for the adapter to confirm before saying "request sent". */
  bookingWaitMs?: number;
}

const MAX_TOOL_CALLS = 8;
const MAX_AUDIO_CHUNK = 64_000;

/**
 * Owns one voice session (MVP spec §11). The model proposes; this class
 * decides. Every tool call is re-validated (identity, offered slots, budget)
 * and executed as a domain command by the AGENT actor, so consent, approval
 * and state guards apply exactly as for staff.
 */
export class VoiceSessionController {
  private live: LiveSession | null = null;
  private identityVerified = false;
  private offered: OfferedSlot[] = [];
  private toolCalls = 0;
  private bookingConfirmed = false;
  private routedToStaff = false;
  private optedOut = false;
  private heardPatient = false;
  private ended = false;
  /** True only once the model connection is open; a failed connect is not a call. */
  private connected = false;
  private startedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private readonly clock: () => Date;
  readonly toolLog: { name: string; outcome: string; at: string }[] = [];
  readonly safetyEvents: { kind: string; at: string }[] = [];
  readonly unsupportedClaims: { at: string }[] = [];

  constructor(
    private readonly info: SessionInfo,
    private readonly deps: ControllerDeps,
    private readonly send: (m: ServerMessage) => void,
  ) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Fire-and-forget work must never become an unhandled rejection (it would end every call on this instance). */
  private background(p: Promise<unknown>): void {
    p.catch((e: Error) =>
      this.deps.log.error('voice background task failed', {
        interactionId: this.info.interactionId,
        error: e.message,
      }),
    );
  }

  private get agent(): ActorContext {
    return {
      tenantId: this.info.tenantId,
      actorType: 'AGENT',
      actorId: `voice:${this.info.interactionId}`,
      roles: [],
      correlationId: this.info.correlationId,
    };
  }
  private get system(): ActorContext {
    return {
      tenantId: this.info.tenantId,
      actorType: 'SYSTEM',
      actorId: 'voice-gateway',
      roles: [],
      correlationId: this.info.correlationId,
    };
  }

  private async readCase(): Promise<Case> {
    const snap = await this.deps.db
      .doc(tenantRecord(this.info.tenantId, 'cases', this.info.caseId))
      .get();
    if (!snap.exists) throw new Error('CASE_NOT_FOUND');
    return snap.data() as Case;
  }

  /** Runs a case command, re-reading the version and retrying once on a concurrent change. */
  private async command(
    step: string,
    run: (
      ctx: ActorContext,
      base: { caseId: string; expectedVersion: number; idempotencyKey: string },
    ) => Promise<CommandResult>,
    ctx = this.agent,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = await this.readCase();
      try {
        return await run(ctx, {
          caseId: c.caseId,
          expectedVersion: c.version,
          idempotencyKey: `voice:${this.info.interactionId}:${step}`,
        });
      } catch (e) {
        if (e instanceof DomainError && e.code === 'VERSION_CONFLICT' && attempt < 2) continue;
        throw e;
      }
    }
    throw new Error('unreachable');
  }

  async start(): Promise<void> {
    const c = await this.readCase();
    if (c.workflowState !== 'CONTACTING' && c.workflowState !== 'AWAITING_BOOKING')
      throw new Error(`CASE_NOT_IN_CONTACT (${c.workflowState})`);
    if (['OPTED_OUT', 'DECLINED'].includes(c.outreachDisposition))
      throw new Error('PATIENT_SUPPRESSED');
    this.live = await this.deps.live.connect(
      { model: this.deps.models.live, system: this.deps.system, tools: TOOLS },
      {
        onAudio: (data, mimeType) => this.send({ type: 'audio', data, mimeType }),
        onInterrupted: () => this.send({ type: 'interrupted' }),
        onTurnComplete: () => undefined,
        onInputTranscript: (t) => this.background(this.onPatientText(t, false)),
        onOutputTranscript: (t) => this.onAgentText(t),
        onToolCalls: (calls) => this.background(this.onToolCalls(calls)),
        onClose: (reason) => {
          if (this.connected) this.background(this.end(reason));
        },
      },
    );
    this.connected = true;
    this.startedAt = this.clock().getTime();
    await this.deps.db
      .doc(tenantRecord(this.info.tenantId, 'interactions', this.info.interactionId))
      .set(
        {
          status: 'ACTIVE',
          startedAt: this.clock().toISOString(),
          model: this.deps.models.live,
          promptVersion: this.deps.promptVersions.conversation,
        },
        { merge: true },
      );
    this.send({
      type: 'ready',
      capSeconds: this.deps.capSeconds,
      simulation: this.info.simulation,
    });
    // Cap the session explicitly, well before the platform request timeout.
    this.timers.push(
      setTimeout(
        () => this.live?.sendText('[Gateway note: about 15 seconds left. Wrap up politely now.]'),
        Math.max(0, (this.deps.capSeconds - 15) * 1000),
      ),
    );
    this.timers.push(
      setTimeout(() => this.background(this.end('SESSION_CAP')), this.deps.capSeconds * 1000),
    );
    this.live.sendText('[Gateway note: the call has connected. Begin with your introduction.]');
  }

  async onClientMessage(m: ClientMessage): Promise<void> {
    if (this.ended || !this.live) return;
    switch (m.type) {
      case 'audio':
        if (typeof m.data === 'string' && m.data.length <= MAX_AUDIO_CHUNK) {
          this.heardPatient = true;
          this.live.sendAudio(m.data);
        }
        return;
      case 'text': {
        const text = String(m.text ?? '')
          .slice(0, 500)
          .trim();
        if (!text) return;
        this.heardPatient = true;
        this.send({ type: 'transcript', who: 'patient', text });
        if (await this.onPatientText(text, true)) return;
        this.live.sendText(text);
        return;
      }
      case 'identity_verified':
        if (this.identityVerified) return;
        this.identityVerified = true;
        this.send({
          type: 'event',
          kind: 'identity',
          detail: this.info.simulation
            ? 'Identity confirmed by supervising staff (simulated)'
            : 'Identity confirmed by staff',
        });
        this.live.sendText(
          "[Gateway note: staff have verified the patient's identity. You may now discuss the follow-up.]",
        );
        return;
      case 'end':
        await this.end('ENDED_BY_STAFF');
        return;
    }
  }

  /** Returns true when the backstop took over this turn. */
  private async onPatientText(text: string, typed: boolean): Promise<boolean> {
    if (!typed) this.send({ type: 'transcript', who: 'patient', text });
    if (this.routedToStaff || !looksLikeMedicalQuestion(text)) return false;
    this.safetyEvents.push({ kind: 'MEDICAL_QUESTION_BACKSTOP', at: this.clock().toISOString() });
    await this.routeToStaff('MEDICAL_QUESTION');
    this.send({
      type: 'event',
      kind: 'safety',
      detail: 'Medical question detected — routed to staff',
    });
    this.live?.sendText(
      '[Gateway note: the patient asked a medical question. Do not answer it. Say: "I can\'t help with medical questions, but I\'ll ask the lab team to call you." Then say goodbye and call end_call.]',
    );
    return true;
  }

  private onAgentText(text: string) {
    this.send({ type: 'transcript', who: 'agent', text });
    if (!this.bookingConfirmed && claimsBooked(text)) {
      this.unsupportedClaims.push({ at: this.clock().toISOString() });
      this.send({
        type: 'event',
        kind: 'qa',
        detail:
          'Agent implied a confirmed booking before the calendar confirmed it (flagged for review)',
      });
    }
  }

  private async routeToStaff(reasonCode: string) {
    if (this.routedToStaff) return { status: 'ALREADY_ROUTED' };
    const c = await this.readCase();
    try {
      await this.command(`handoff`, (ctx, base) =>
        this.deps.commands.createHandoff(ctx, {
          ...base,
          input: {
            reasonCode,
            ownerId: c.ownerId,
            dueAt: new Date(this.clock().getTime() + 4 * 3_600_000).toISOString(),
          },
        }),
      );
    } catch (e) {
      if (!(e instanceof DomainError && e.reason === 'HANDOFF_ALREADY_OPEN')) throw e;
    }
    this.routedToStaff = true;
    this.background(this.deps.dispatcher.dispatchCase(this.info.tenantId, this.info.caseId));
    return { status: 'ROUTED_TO_STAFF' };
  }

  private async onToolCalls(calls: ToolCall[]) {
    const responses = [];
    for (const call of calls) {
      let response: Record<string, unknown>;
      try {
        response = await this.runTool(call);
      } catch (e) {
        const reason = e instanceof DomainError ? e.reason : 'TOOL_FAILED';
        this.deps.log.warn('voice tool failed', {
          tool: call.name,
          reason,
          interactionId: this.info.interactionId,
        });
        response = {
          error: reason,
          instruction: 'Do not say this worked. Offer a call back from the lab.',
        };
      }
      this.toolLog.push({
        name: call.name,
        outcome: String(response.status ?? response.error ?? 'OK'),
        at: this.clock().toISOString(),
      });
      responses.push({ id: call.id, name: call.name, response });
    }
    if (!this.ended) this.live?.sendToolResponses(responses);
  }

  private needIdentity(): Record<string, unknown> | null {
    return this.identityVerified
      ? null
      : {
          error: 'IDENTITY_NOT_VERIFIED',
          instruction:
            'Do not share details. Ask the person to confirm they are the patient and wait for staff.',
        };
  }

  private async runTool(call: ToolCall): Promise<Record<string, unknown>> {
    if (++this.toolCalls > MAX_TOOL_CALLS) {
      await this.routeToStaff('TOOL_BUDGET_EXCEEDED');
      return {
        error: 'TOOL_BUDGET_EXCEEDED',
        instruction: 'Tell the patient the lab team will call them, then end the call.',
      };
    }
    if (this.optedOut && call.name !== 'end_call')
      return { error: 'PATIENT_OPTED_OUT', instruction: 'Thank them and end the call.' };
    switch (call.name) {
      case 'find_slots': {
        const blocked = this.needIdentity();
        if (blocked) return blocked;
        const c = await this.readCase();
        const raw = await this.deps.booking.listSlots(
          {
            tenantId: this.info.tenantId,
            operationId: `slots-${c.caseId}`,
            correlationId: this.info.correlationId,
          },
          {
            siteId: c.siteId,
            actionType: c.actionType,
            from: this.clock().toISOString(),
            to: c.dueAt,
          },
        );
        const fmt = new Intl.DateTimeFormat('en-IN', {
          timeZone: this.info.siteTimeZone,
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit',
        });
        const slots: OfferedSlot[] = raw.map((s) => ({
          slotId: s.slotId,
          startsAt: s.startsAt,
          label: fmt.format(new Date(s.startsAt)),
          location: s.location,
        }));
        const r = await coordinate(this.deps.coordinationModel, this.deps.models.coordination, {
          caseId: c.caseId,
          approvalRevision: c.approvalRevision,
          preference: String(call.args.preference ?? ''),
          slots,
        });
        this.offered = r.ranked;
        this.send({
          type: 'event',
          kind: 'tool',
          detail: `Looked up times: ${r.ranked.length} offered (${r.source === 'model' ? 'coordination agent' : 'rule-based fallback'})`,
        });
        if (r.ranked.length === 0)
          return {
            status: 'NO_SLOTS',
            instruction:
              'No times are available before the deadline. Offer a call back from the lab.',
          };
        return {
          status: 'OK',
          slots: r.ranked.map((s) => ({ slot_id: s.slotId, when: s.label, where: s.location })),
        };
      }
      case 'request_booking': {
        const blocked = this.needIdentity();
        if (blocked) return blocked;
        const slot = this.offered.find((s) => s.slotId === call.args.slot_id);
        if (!slot)
          return {
            error: 'SLOT_NOT_OFFERED',
            instruction: 'Only offer times returned by find_slots.',
          };
        if (call.args.patient_confirmed !== true)
          return {
            error: 'NOT_CONFIRMED',
            instruction: 'Read back the date, time and place and ask for a clear yes first.',
          };
        let c = await this.readCase();
        if (c.workflowState === 'CONTACTING') {
          await this.command('patient-request-book', (ctx, base) =>
            this.deps.commands.recordPatientRequest(ctx, {
              ...base,
              input: {
                interactionId: this.info.interactionId,
                identityAssurance: this.info.simulation ? 'SIMULATED' : 'VERIFIED',
                request: 'BOOK',
              },
            }),
          );
        }
        await this.command(`booking-${slot.slotId}`, (ctx, base) =>
          this.deps.commands.requestBooking(ctx, {
            ...base,
            input: { slotId: slot.slotId, patientConfirmedSlot: true },
          }),
        );
        this.send({ type: 'event', kind: 'tool', detail: `Booking requested for ${slot.label}` });
        await this.deps.dispatcher.dispatchCase(this.info.tenantId, this.info.caseId);
        // Wait briefly for the adapter's acknowledgment; never claim more than is known.
        const deadline = Date.now() + (this.deps.bookingWaitMs ?? 8000);
        while (Date.now() < deadline) {
          c = await this.readCase();
          if (c.bookingState !== 'REQUESTED') break;
          await new Promise((r) => setTimeout(r, 400));
        }
        if (c.bookingState === 'CONFIRMED') {
          this.bookingConfirmed = true;
          this.send({ type: 'event', kind: 'tool', detail: 'Calendar confirmed the booking' });
          return { status: 'CONFIRMED', when: slot.label, where: slot.location };
        }
        if (c.bookingState === 'NONE')
          return {
            status: 'NOT_AVAILABLE',
            instruction: 'That time was just taken. Call find_slots again or offer a call back.',
          };
        return {
          status: 'REQUEST_SENT',
          instruction:
            'Say the request is with the lab and they will confirm. Do not say it is booked.',
        };
      }
      case 'request_callback': {
        const c = await this.readCase();
        if (c.workflowState === 'CONTACTING') {
          await this.command('patient-request-callback', (ctx, base) =>
            this.deps.commands.recordPatientRequest(ctx, {
              ...base,
              input: {
                interactionId: this.info.interactionId,
                identityAssurance: this.info.simulation ? 'SIMULATED' : 'VERIFIED',
                request: 'CALLBACK',
              },
            }),
          );
          this.routedToStaff = true;
        } else {
          await this.routeToStaff('CALLBACK_REQUESTED');
        }
        this.send({
          type: 'event',
          kind: 'tool',
          detail: 'Callback requested — staff task created',
        });
        return { status: 'CALLBACK_REQUESTED' };
      }
      case 'route_to_staff': {
        const reason = [
          'MEDICAL_QUESTION',
          'PATIENT_REQUESTED_HUMAN',
          'NOT_THE_PATIENT',
          'OTHER',
        ].includes(String(call.args.reason_code))
          ? String(call.args.reason_code)
          : 'OTHER';
        const r = await this.routeToStaff(reason);
        this.send({
          type: 'event',
          kind: 'tool',
          detail: `Routed to staff (${reason.toLowerCase().replaceAll('_', ' ')})`,
        });
        return r;
      }
      case 'record_opt_out': {
        await this.command('opt-out', (ctx, base) =>
          this.deps.commands.optOut(ctx, { ...base, input: { channel: 'ALL' } }),
        );
        this.optedOut = true;
        this.send({
          type: 'event',
          kind: 'tool',
          detail: 'Patient opted out — automated contact stopped',
        });
        this.background(this.deps.dispatcher.dispatchCase(this.info.tenantId, this.info.caseId));
        this.timers.push(setTimeout(() => this.background(this.end('OPTED_OUT')), 8000));
        return {
          status: 'OPTED_OUT',
          instruction:
            'Thank them, confirm they will not be contacted automatically again, and end the call.',
        };
      }
      case 'end_call':
        this.timers.push(setTimeout(() => this.background(this.end('AGENT_ENDED')), 2500));
        return { status: 'ENDING' };
      default:
        return { error: 'UNKNOWN_TOOL' };
    }
  }

  /** Idempotent. Persists only a compact disposition (no transcript, no audio). */
  async end(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.timers.forEach(clearTimeout);
    if (!this.connected) {
      // Never reached the model: record the failure, but no contact outcome and no billed audio.
      await this.deps.db
        .doc(tenantRecord(this.info.tenantId, 'interactions', this.info.interactionId))
        .set(
          { status: 'FAILED_TO_CONNECT', endedAt: this.clock().toISOString(), endReason: reason },
          { merge: true },
        )
        .catch(() => undefined);
      return;
    }
    try {
      this.live?.close();
    } catch {
      /* already closed */
    }
    const audioSeconds = this.startedAt
      ? Math.min(this.deps.capSeconds, Math.ceil((this.clock().getTime() - this.startedAt) / 1000))
      : 0;
    const outcome: ContactOutcome | null =
      this.identityVerified || this.optedOut
        ? 'REACHED'
        : this.heardPatient
          ? 'REACHED'
          : 'RETRY_SCHEDULED';
    const disposition = this.optedOut
      ? 'OPTED_OUT'
      : this.bookingConfirmed
        ? 'BOOKED'
        : this.routedToStaff
          ? 'HANDED_TO_STAFF'
          : this.identityVerified
            ? 'REACHED'
            : outcome;
    try {
      await this.command(
        'ended',
        (ctx, base) =>
          this.deps.commands.recordInteractionEnded(ctx, {
            ...base,
            input: { interactionId: this.info.interactionId, audioSeconds, outcome },
          }),
        this.system,
      );
    } catch (e) {
      this.deps.log.warn('could not record interaction end', {
        interactionId: this.info.interactionId,
        error: e instanceof DomainError ? e.reason : (e as Error).message,
      });
    }
    await this.deps.db
      .doc(tenantRecord(this.info.tenantId, 'interactions', this.info.interactionId))
      .set(
        {
          status: 'ENDED',
          endedAt: this.clock().toISOString(),
          endReason: reason,
          audioSeconds,
          disposition,
          identityAssurance: this.identityVerified
            ? this.info.simulation
              ? 'SIMULATED'
              : 'VERIFIED'
            : 'NONE',
          toolCalls: this.toolLog,
          safetyEvents: this.safetyEvents,
          unsupportedClaims: this.unsupportedClaims.length,
          coordinationPromptVersion: this.deps.promptVersions.coordination,
        },
        { merge: true },
      )
      .catch((e: Error) => this.deps.log.warn('could not store interaction', { error: e.message }));
    this.background(this.deps.dispatcher.dispatchCase(this.info.tenantId, this.info.caseId));
    this.send({ type: 'ended', reason, disposition, audioSeconds });
  }
}
