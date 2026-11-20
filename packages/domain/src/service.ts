import type {
  ActionType,
  Case,
  ContactChannel,
  EventEnvelope,
  SupportedLanguage,
} from '@careloop/contracts';
import type { ApprovalCheck } from './approval';
import { assertPermitted, type ActorContext, type CommandName } from './context';
import { DomainError, guardFailed, notFound, versionConflict } from './errors';
import { caseFingerprint } from './fingerprint';
import { hashPayload, sha256 } from './hashing';
import type { CommandResult, OperationRecord, OutboxRecord, Store, Tx } from './store';
import * as T from './transitions';
import { matchEvidence } from './evidence';
import type { EvidenceDoc, EvidenceEventType, HandoffDoc } from './records';

export interface ServiceConfig {
  outreachEnabled: boolean;
  maxContactAttempts: number;
  maxCaseAudioSeconds: number;
}

export interface ServiceDeps {
  store: Store;
  config: ServiceConfig;
  clock?: () => Date;
}

/** Common envelope for every state-changing command (MVP spec §14). */
export interface CommandRequest<I> {
  caseId: string;
  expectedVersion: number;
  idempotencyKey: string;
  input: I;
}

export interface CreateCaseInput {
  caseId: string;
  siteId: string;
  patientId: string;
  sourceId: string;
  consentId: string;
  actionType: ActionType;
  actionText: string;
  dueAt: string;
  ownerId: string;
  language: SupportedLanguage;
}

export interface EvidenceInput {
  evidenceId: string;
  kind: 'PROVIDER_EVENT' | 'STAFF_RECORD' | 'SELF_REPORT';
  issuer: string;
  eventType: EvidenceEventType;
  patientRef: string | null;
  bookingRef: string | null;
  occurredAt: string;
  sourceRef: string;
  sourceHash?: string | null;
  simulation: boolean;
  excerpt?: string | null;
  aiReview?: Record<string, unknown> | null;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function resultOf(
  c: Case,
  eventId: string,
  eventType: string,
  warnings: string[] = [],
  operationId: string | null = null,
): CommandResult {
  return {
    caseId: c.caseId,
    version: c.version,
    workflowState: c.workflowState,
    outreachDisposition: c.outreachDisposition,
    handoffState: c.handoffState,
    evidenceState: c.evidenceState,
    bookingState: c.bookingState,
    automationPausedReason: c.automationPausedReason,
    eventId,
    eventType,
    operationId,
    replayed: false,
    warnings,
  };
}

/**
 * The only way case state changes. Each command runs in one transaction:
 * idempotency lookup → load + version check → pure guard → write case, event,
 * outbox items and operation record together. tenantId/actor always come from
 * ActorContext, never from input.
 */
export class CaseCommands {
  private readonly clock: () => Date;

  constructor(private readonly deps: ServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  // ---- helpers -------------------------------------------------------------

  private operationId(ctx: ActorContext, command: CommandName, key: string): string {
    if (!key || key.length > 200)
      throw new DomainError('VALIDATION_FAILED', 'IDEMPOTENCY_KEY_REQUIRED');
    return sha256(`${ctx.tenantId}\u001f${command}\u001f${key}`);
  }

  /** Returns the stored result for a replay, or throws when the key was used with a different payload. */
  private async replay(
    tx: Tx,
    operationId: string,
    payloadHash: string,
  ): Promise<CommandResult | null> {
    const op = await tx.getOperation(operationId);
    if (!op) return null;
    if (op.payloadHash !== payloadHash) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REUSED',
        'IDEMPOTENCY_KEY_REUSED',
        'idempotency key reused with a different request',
      );
    }
    return { ...op.result, replayed: true };
  }

  private write(
    tx: Tx,
    ctx: ActorContext,
    args: {
      command: CommandName;
      operationId: string;
      idempotencyKey: string;
      payloadHash: string;
      before: Case | null;
      after: Case;
      transition: Pick<T.Transition, 'eventType' | 'payload' | 'outbox'>;
      simulation: boolean;
      now: Date;
      warnings?: string[];
    },
  ): CommandResult {
    const { after, now } = args;
    const ts = now.toISOString();
    const eventId = `${after.caseId}-v${after.version}`;
    const event: EventEnvelope = {
      schemaVersion: 1,
      eventId,
      eventType: args.transition.eventType,
      tenantId: ctx.tenantId,
      caseId: after.caseId,
      correlationId: ctx.correlationId,
      operationId: args.operationId,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      occurredAt: ts,
      receivedAt: ts,
      ...(args.before ? { previousVersion: args.before.version } : {}),
      nextVersion: after.version,
      simulation: args.simulation,
      payload: args.transition.payload,
    };
    this.syncHandoff(tx, ctx, args.before, after, args.transition, now);
    tx.putCase(after);
    tx.appendEvent(event);
    (args.transition.outbox ?? []).forEach((draft, i) => {
      const item: OutboxRecord = {
        outboxId: `${args.operationId}-${i}`,
        tenantId: ctx.tenantId,
        caseId: after.caseId,
        caseVersion: after.version,
        operationId: args.operationId,
        correlationId: ctx.correlationId,
        kind: draft.kind,
        payload: draft.payload,
        status: 'PENDING',
        attempts: 0,
        createdAt: ts,
      };
      tx.enqueueOutbox(item);
    });
    const result = resultOf(
      after,
      eventId,
      args.transition.eventType,
      args.warnings,
      args.operationId,
    );
    const op: OperationRecord = {
      operationId: args.operationId,
      command: args.command,
      idempotencyKey: args.idempotencyKey,
      payloadHash: args.payloadHash,
      caseId: after.caseId,
      result,
      createdAt: ts,
    };
    tx.putOperation(op);
    return result;
  }

  /**
   * Shared pipeline for commands on an existing case. `decide` may read more
   * facts through `tx` but must not write; it returns the pure transition.
   */
  private async execute<I>(
    ctx: ActorContext,
    command: CommandName,
    req: CommandRequest<I>,
    decide: (
      c: Case,
      tx: Tx,
      now: Date,
      operationId: string,
    ) => Promise<T.Transition> | T.Transition,
    opts: { simulation?: boolean } = {},
  ): Promise<CommandResult> {
    assertPermitted(ctx, command);
    const operationId = this.operationId(ctx, command, req.idempotencyKey);
    const payloadHash = hashPayload({
      command,
      caseId: req.caseId,
      expectedVersion: req.expectedVersion,
      input: req.input,
    });
    return this.deps.store.runTransaction(ctx.tenantId, async (tx) => {
      const replayed = await this.replay(tx, operationId, payloadHash);
      if (replayed) return replayed;
      const c = await tx.getCase(req.caseId);
      if (!c) throw notFound('CASE');
      if (c.version !== req.expectedVersion) throw versionConflict(req.expectedVersion, c.version);
      const tenant = await tx.getTenant();
      if (!tenant) throw notFound('TENANT');
      const now = this.clock();
      const t = await decide(c, tx, now, operationId);
      const after: Case = {
        ...c,
        ...t.patch,
        version: c.version + 1,
        updatedAt: now.toISOString(),
      };
      return this.write(tx, ctx, {
        command,
        operationId,
        idempotencyKey: req.idempotencyKey,
        payloadHash,
        before: c,
        after,
        transition: t,
        simulation: tenant.simulation || (opts.simulation ?? false),
        now,
      });
    });
  }

  private async load<X>(get: Promise<X | null>, what: string): Promise<X> {
    const x = await get;
    if (!x) throw notFound(what);
    return x;
  }

  /**
   * Keeps the handoff record in step with the case's handoff axis, whichever
   * command moved it (agent handoff, callback request, unreachable patient,
   * staff action). Write-only, so it is safe after the transaction's reads.
   */
  private syncHandoff(
    tx: Tx,
    ctx: ActorContext,
    before: Case | null,
    after: Case,
    t: Pick<T.Transition, 'eventType' | 'payload'>,
    now: Date,
  ) {
    const prev = before?.handoffState ?? 'NONE';
    const ts = now.toISOString();
    if (after.handoffState === 'PENDING' && prev !== 'PENDING' && prev !== 'ACKNOWLEDGED') {
      const handoffId = `${after.caseId}-h${after.version}`;
      const doc: HandoffDoc = {
        handoffId,
        caseId: after.caseId,
        reasonCode: String(
          t.payload.reasonCode ??
            (t.payload.request === 'CALLBACK' ? 'CALLBACK_REQUESTED' : `AFTER_${t.eventType}`),
        ),
        ownerId: String(t.payload.ownerId ?? after.ownerId),
        status: 'PENDING',
        createdBy: ctx.actorId,
        createdAt: ts,
        dueAt:
          typeof t.payload.dueAt === 'string'
            ? t.payload.dueAt
            : new Date(now.getTime() + 4 * 3_600_000).toISOString(),
        acknowledgedBy: null,
        acknowledgedAt: null,
        resolvedBy: null,
        resolvedAt: null,
        resolution: null,
        backupNotifiedAt: null,
      };
      tx.putHandoff(doc, 'create');
      after.activeHandoffId = handoffId;
      return;
    }
    const id = after.activeHandoffId;
    if (!id) return;
    if (after.handoffState === 'ACKNOWLEDGED' && prev === 'PENDING') {
      tx.putHandoff(
        { handoffId: id, status: 'ACKNOWLEDGED', acknowledgedBy: ctx.actorId, acknowledgedAt: ts },
        'merge',
      );
    } else if (after.handoffState === 'RESOLVED' && prev !== 'RESOLVED') {
      tx.putHandoff(
        {
          handoffId: id,
          status: 'RESOLVED',
          resolvedBy: ctx.actorId,
          resolvedAt: ts,
          resolution: String(t.payload.resolution ?? ''),
        },
        'merge',
      );
      after.activeHandoffId = null;
    } else if (t.eventType === 'HANDOFF_REASSIGNED') {
      tx.putHandoff(
        {
          handoffId: id,
          ownerId: String(t.payload.ownerId),
          status: 'PENDING',
          acknowledgedBy: null,
          acknowledgedAt: null,
          backupNotifiedAt: null,
        },
        'merge',
      );
    }
  }

  // ---- commands ------------------------------------------------------------

  /**
   * MVP-01. Creates a DRAFT (never authorizes outreach). A second ticket for
   * the same source + obligation returns the existing case with a warning.
   */
  async createCase(
    ctx: ActorContext,
    req: { idempotencyKey: string; input: CreateCaseInput },
  ): Promise<CommandResult> {
    assertPermitted(ctx, 'createCase');
    const input = req.input;
    const bad: Record<string, string> = {};
    for (const k of [
      'caseId',
      'siteId',
      'patientId',
      'sourceId',
      'consentId',
      'ownerId',
    ] as const) {
      if (!ID.test(input[k] ?? '')) bad[k] = 'invalid id';
    }
    if (!input.actionText?.trim()) bad.actionText = 'required';
    if (Number.isNaN(Date.parse(input.dueAt))) bad.dueAt = 'invalid datetime';
    if (Object.keys(bad).length)
      throw new DomainError('VALIDATION_FAILED', 'VALIDATION_FAILED', 'invalid case', bad);

    const operationId = this.operationId(ctx, 'createCase', req.idempotencyKey);
    const payloadHash = hashPayload({ command: 'createCase', input });
    return this.deps.store.runTransaction(ctx.tenantId, async (tx) => {
      const replayed = await this.replay(tx, operationId, payloadHash);
      if (replayed) return replayed;

      // Every reference must resolve inside this tenant; cross-tenant ids look like 404.
      const tenant = await this.load(tx.getTenant(), 'TENANT');
      await this.load(tx.getSite(input.siteId), 'SITE');
      const patient = await this.load(tx.getPatient(input.patientId), 'PATIENT');
      const consent = await this.load(tx.getConsent(input.consentId), 'CONSENT');
      const source = await this.load(tx.getSource(input.sourceId), 'SOURCE');
      const owner = await this.load(tx.getMember(input.ownerId), 'OWNER');
      if (consent.patientId !== patient.patientId) throw guardFailed('CONSENT_PATIENT_MISMATCH');
      if (owner.status !== 'ACTIVE') throw guardFailed('OWNER_NOT_ACTIVE');

      const fingerprint = caseFingerprint({
        tenantId: ctx.tenantId,
        sourceAuthority: source.sourceAuthority,
        sourceReference: source.reference,
        obligationKey: input.actionType,
      });
      const existingId = await tx.getCaseIdByFingerprint(fingerprint);
      if (existingId) {
        const existing = await this.load(tx.getCase(existingId), 'CASE');
        return {
          ...resultOf(existing, `${existing.caseId}-v${existing.version}`, 'DUPLICATE_DETECTED', [
            'DUPLICATE_SOURCE_ACTION',
          ]),
        };
      }
      if (await tx.getCase(input.caseId))
        throw new DomainError('VERSION_CONFLICT', 'CASE_ID_TAKEN');

      const now = this.clock();
      const ts = now.toISOString();
      const consentActive = T.consentIsActive(consent, now);
      const c: Case = {
        ...input,
        approvalRevision: 0,
        approvalHash: null,
        approvedAt: null,
        approvedBy: null,
        contactAttempts: 0,
        audioSecondsUsed: 0,
        bookedStartsAt: null,
        bookingRef: null,
        activeHandoffId: null,
        workflowState: 'DRAFT',
        outreachDisposition: 'NOT_STARTED',
        handoffState: 'NONE',
        evidenceState: 'NONE',
        bookingState: 'NONE',
        automationPausedReason: consentActive ? 'REVIEW_REQUIRED' : 'CONSENT',
        fingerprint,
        version: 1,
        createdBy: ctx.actorId,
        createdAt: ts,
        updatedAt: ts,
      };
      tx.createFingerprint(fingerprint, c.caseId);
      const missing = patient.ageEligibility === 'ADULT_CONFIRMED' ? [] : ['adultEligibility'];
      return this.write(tx, ctx, {
        command: 'createCase',
        operationId,
        idempotencyKey: req.idempotencyKey,
        payloadHash,
        before: null,
        after: c,
        transition: {
          eventType: 'CASE_CREATED',
          payload: { actionType: c.actionType, missingFields: missing },
          outbox: [],
        },
        simulation: tenant.simulation,
        now,
      });
    });
  }

  editDraft(ctx: ActorContext, req: CommandRequest<T.DraftEdit>) {
    return this.execute(ctx, 'editDraft', req, async (c, tx) => {
      if (req.input.ownerId) {
        const owner = await this.load(tx.getMember(req.input.ownerId), 'OWNER');
        if (owner.status !== 'ACTIVE') throw guardFailed('OWNER_NOT_ACTIVE');
      }
      if (req.input.consentId || req.input.patientId) {
        const consent = await this.load(
          tx.getConsent(req.input.consentId ?? c.consentId),
          'CONSENT',
        );
        const patientId = req.input.patientId ?? c.patientId;
        await this.load(tx.getPatient(patientId), 'PATIENT');
        if (consent.patientId !== patientId) throw guardFailed('CONSENT_PATIENT_MISMATCH');
      }
      return T.editDraft(c, req.input);
    });
  }

  /** MVP-02. Reviewer identity comes from the session, not the body. */
  approve(
    ctx: ActorContext,
    req: CommandRequest<{ sourceAuthorityRef: string; checkedFields: ApprovalCheck[] }>,
  ) {
    return this.execute(ctx, 'approve', req, async (c, tx, now) => {
      const consent = await this.load(tx.getConsent(c.consentId), 'CONSENT');
      const patient = await this.load(tx.getPatient(c.patientId), 'PATIENT');
      const owner = await tx.getMember(c.ownerId);
      return T.approve(
        c,
        { consent, patient, ownerIsActiveMember: owner?.status === 'ACTIVE' },
        {
          reviewerId: ctx.actorId,
          sourceAuthorityRef: req.input.sourceAuthorityRef,
          checkedFields: req.input.checkedFields,
          now,
        },
      );
    });
  }

  /** MVP-03. All eligibility is re-checked here, at execution time. */
  dispatchContact(ctx: ActorContext, req: CommandRequest<{ channel: ContactChannel }>) {
    return this.execute(ctx, 'dispatchContact', req, async (c, tx, now) => {
      const [tenant, site, consent, patient] = await Promise.all([
        this.load(tx.getTenant(), 'TENANT'),
        this.load(tx.getSite(c.siteId), 'SITE'),
        this.load(tx.getConsent(c.consentId), 'CONSENT'),
        this.load(tx.getPatient(c.patientId), 'PATIENT'),
      ]);
      return T.dispatchContact(c, {
        tenant,
        site,
        consent,
        patient,
        now,
        channel: req.input.channel,
        outreachEnabled: this.deps.config.outreachEnabled,
        maxContactAttempts: this.deps.config.maxContactAttempts,
        maxCaseAudioSeconds: this.deps.config.maxCaseAudioSeconds,
      });
    });
  }

  recordContactOutcome(
    ctx: ActorContext,
    req: CommandRequest<{ outcome: T.ContactOutcome; audioSeconds: number }>,
  ) {
    return this.execute(ctx, 'recordContactOutcome', req, (c) =>
      T.recordContactOutcome(c, {
        ...req.input,
        maxContactAttempts: this.deps.config.maxContactAttempts,
      }),
    );
  }

  recordInteractionEnded(
    ctx: ActorContext,
    req: CommandRequest<{
      interactionId: string;
      audioSeconds: number;
      outcome: T.ContactOutcome | null;
    }>,
  ) {
    return this.execute(ctx, 'recordInteractionEnded', req, (c) =>
      T.recordInteractionEnded(c, {
        ...req.input,
        maxContactAttempts: this.deps.config.maxContactAttempts,
      }),
    );
  }

  recordPatientRequest(
    ctx: ActorContext,
    req: CommandRequest<Parameters<typeof T.recordPatientRequest>[1]>,
  ) {
    return this.execute(
      ctx,
      'recordPatientRequest',
      req,
      (c) => T.recordPatientRequest(c, req.input),
      {
        simulation: req.input.identityAssurance === 'SIMULATED',
      },
    );
  }

  requestBooking(
    ctx: ActorContext,
    req: CommandRequest<{ slotId: string; patientConfirmedSlot: boolean }>,
  ) {
    return this.execute(ctx, 'requestBooking', req, (c, _tx, _now, operationId) =>
      T.requestBooking(c, { ...req.input, operationId }),
    );
  }

  confirmBooking(ctx: ActorContext, req: CommandRequest<Parameters<typeof T.confirmBooking>[1]>) {
    return this.execute(ctx, 'confirmBooking', req, (c) => T.confirmBooking(c, req.input), {
      simulation: req.input.simulation,
    });
  }

  markBookingUnknown(ctx: ActorContext, req: CommandRequest<{ operationId: string }>) {
    return this.execute(ctx, 'markBookingUnknown', req, (c) => T.markBookingUnknown(c, req.input));
  }

  recordBookingCancelled(ctx: ActorContext, req: CommandRequest<{ externalRef: string }>) {
    return this.execute(ctx, 'recordBookingCancelled', req, async (c, tx, now) => {
      const consent = await this.load(tx.getConsent(c.consentId), 'CONSENT');
      return T.recordBookingCancelled(c, { externalRef: req.input.externalRef, consent, now });
    });
  }

  recordBookingRejected(
    ctx: ActorContext,
    req: CommandRequest<{ reason: string; operationId: string }>,
  ) {
    return this.execute(ctx, 'recordBookingRejected', req, (c) =>
      T.recordBookingRejected(c, req.input),
    );
  }

  requestBookingCancellation(
    ctx: ActorContext,
    req: CommandRequest<{ externalRef: string; reason: string }>,
  ) {
    return this.execute(ctx, 'requestBookingCancellation', req, (c) =>
      T.requestBookingCancellation(c, req.input),
    );
  }

  awaitEvidence(
    ctx: ActorContext,
    req: CommandRequest<{ trigger: 'OCCURRENCE_PASSED' | 'COMPLETION_CLAIM' }>,
  ) {
    return this.execute(ctx, 'awaitEvidence', req, (c, _tx, now) =>
      T.awaitEvidence(c, { now, trigger: req.input.trigger }),
    );
  }

  recordSelfReport(
    ctx: ActorContext,
    req: CommandRequest<{ statedOccurredAt?: string; interactionId?: string }>,
  ) {
    return this.execute(ctx, 'recordSelfReport', req, (c) => T.recordSelfReport(c, req.input));
  }

  recordEvidenceReview(
    ctx: ActorContext,
    req: CommandRequest<Parameters<typeof T.recordEvidenceReview>[1]>,
  ) {
    return this.execute(ctx, 'recordEvidenceReview', req, (c) =>
      T.recordEvidenceReview(c, req.input),
    );
  }

  /**
   * MVP-09. Staff attestation is VERIFIER-only and names the verifier from the
   * session. A TRUSTED_EVENT must come from the system after deterministic matching.
   */
  async verifyCompletion(
    ctx: ActorContext,
    req: CommandRequest<
      | {
          kind: 'TRUSTED_EVENT';
          evidenceId: string;
          occurredAt: string;
          sourceRef: string;
          simulation: boolean;
        }
      | {
          kind: 'STAFF_ATTESTATION';
          evidenceId: string;
          occurredAt: string;
          sourceRef: string;
          reason: string;
        }
    >,
  ) {
    const input = req.input;
    if (
      input.kind === 'STAFF_ATTESTATION' &&
      !(ctx.actorType === 'STAFF' && ctx.roles.includes('VERIFIER'))
    ) {
      throw new DomainError('FORBIDDEN', 'ONLY_VERIFIER_CAN_ATTEST');
    }
    if (input.kind === 'TRUSTED_EVENT' && ctx.actorType !== 'SYSTEM') {
      throw new DomainError('FORBIDDEN', 'TRUSTED_EVENT_MUST_COME_FROM_MATCHER');
    }
    const ev: T.CompletionEvidence =
      input.kind === 'TRUSTED_EVENT'
        ? {
            kind: 'TRUSTED_EVENT',
            evidenceId: input.evidenceId,
            occurredAt: input.occurredAt,
            sourceRef: input.sourceRef,
            matched: true,
          }
        : { ...input, verifierId: ctx.actorId };
    return this.execute(
      ctx,
      'verifyCompletion',
      req,
      (c, _tx, now) => T.verifyCompletion(c, ev, now),
      {
        simulation: input.kind === 'TRUSTED_EVENT' && input.simulation,
      },
    );
  }

  /** MVP-07. */
  optOut(ctx: ActorContext, req: CommandRequest<{ channel: 'ALL' | ContactChannel }>) {
    return this.execute(ctx, 'optOut', req, (c) =>
      T.optOut(c, { channel: req.input.channel, source: ctx.actorType }),
    );
  }

  /** MVP-06 / exceptions. */
  createHandoff(
    ctx: ActorContext,
    req: CommandRequest<{ reasonCode: string; ownerId: string; dueAt: string }>,
  ) {
    return this.execute(ctx, 'createHandoff', req, async (c, tx) => {
      const owner = await this.load(tx.getMember(req.input.ownerId), 'OWNER');
      if (owner.status !== 'ACTIVE') throw guardFailed('OWNER_NOT_ACTIVE');
      return T.createHandoff(c, req.input);
    });
  }

  /** MVP-11. */
  acknowledgeHandoff(ctx: ActorContext, req: CommandRequest<Record<string, never>>) {
    return this.execute(ctx, 'acknowledgeHandoff', req, async (c, tx) => {
      // The named owner takes responsibility; an owner or reviewer may take it over.
      const h = c.activeHandoffId ? await tx.getHandoff(c.activeHandoffId) : null;
      if (
        h &&
        h.ownerId !== ctx.actorId &&
        !ctx.roles.some((r) => r === 'OWNER' || r === 'REVIEWER')
      ) {
        throw new DomainError('FORBIDDEN', 'NOT_HANDOFF_OWNER');
      }
      return T.acknowledgeHandoff(c, { staffId: ctx.actorId });
    });
  }

  reassignHandoff(ctx: ActorContext, req: CommandRequest<{ ownerId: string }>) {
    return this.execute(ctx, 'reassignHandoff', req, async (c, tx) => {
      const m = await this.load(tx.getMember(req.input.ownerId), 'OWNER');
      if (m.status !== 'ACTIVE') throw guardFailed('OWNER_NOT_ACTIVE');
      return T.reassignHandoff(c, { ownerId: req.input.ownerId });
    });
  }

  /**
   * MVP-08/09: record an evidence candidate and apply the deterministic match
   * in one transaction. Provider events that match complete the case; staff
   * records wait for a verifier; mismatches are rejected or conflicted with a
   * reason; self-reports are kept separate.
   */
  async recordEvidence(ctx: ActorContext, req: CommandRequest<EvidenceInput>) {
    const input = req.input;
    const command: CommandName =
      input.kind === 'PROVIDER_EVENT'
        ? 'recordProviderEvidence'
        : input.kind === 'STAFF_RECORD'
          ? 'recordStaffEvidence'
          : 'recordSelfReport';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.evidenceId))
      throw new DomainError('VALIDATION_FAILED', 'INVALID_EVIDENCE_ID');
    return this.execute(
      ctx,
      command,
      req,
      async (c, tx, now) => {
        if (await tx.getEvidence(input.evidenceId))
          throw new DomainError('VERSION_CONFLICT', 'EVIDENCE_EXISTS');
        const patient = await this.load(tx.getPatient(c.patientId), 'PATIENT');
        let t: T.Transition;
        let status: EvidenceDoc['status'];
        let reasons: string[] = [];
        if (input.kind === 'SELF_REPORT') {
          t = T.recordSelfReport(c, { statedOccurredAt: input.occurredAt });
          status = 'SELF_REPORTED';
        } else {
          const m = matchEvidence(c, patient, { ...input, kind: input.kind }, now);
          reasons = m.reasons;
          if (m.outcome === 'MATCH') {
            t = T.verifyCompletion(
              c,
              {
                kind: 'TRUSTED_EVENT',
                evidenceId: input.evidenceId,
                occurredAt: input.occurredAt,
                sourceRef: input.sourceRef,
                matched: true,
              },
              now,
            );
            status = 'VERIFIED';
          } else if (m.outcome === 'REVIEW') {
            t = T.recordEvidenceReview(c, {
              evidenceId: input.evidenceId,
              result: 'UNDER_REVIEW',
              reasonCode: 'AWAITING_ATTESTATION',
            });
            status = 'CANDIDATE';
          } else {
            const result = m.outcome === 'CONFLICT' ? 'CONFLICTED' : 'REJECTED';
            // A wrong record never downgrades a case whose other evidence is still under review.
            t = T.recordEvidenceReview(c, {
              evidenceId: input.evidenceId,
              result,
              reasonCode: m.reasons[0]!,
            });
            if (
              result === 'REJECTED' &&
              (c.evidenceState === 'UNDER_REVIEW' ||
                c.evidenceState === 'CONFLICTED' ||
                c.evidenceState === 'SELF_REPORTED')
            ) {
              t = { ...t, patch: {} };
            }
            status = result;
          }
        }
        const doc: EvidenceDoc = {
          evidenceId: input.evidenceId,
          caseId: c.caseId,
          kind: input.kind,
          issuer: input.issuer,
          eventType: input.eventType,
          patientRef: input.patientRef,
          bookingRef: input.bookingRef,
          occurredAt: input.occurredAt,
          receivedAt: now.toISOString(),
          sourceRef: input.sourceRef,
          sourceHash: input.sourceHash ?? null,
          simulation: input.simulation,
          status,
          reasons,
          excerpt: input.excerpt ? input.excerpt.slice(0, 2000) : null,
          aiReview: input.aiReview ?? null,
          recordedBy: ctx.actorId,
          decidedBy: status === 'VERIFIED' ? ctx.actorId : null,
          decidedAt: status === 'VERIFIED' ? now.toISOString() : null,
          decisionReason: status === 'VERIFIED' ? 'DETERMINISTIC_MATCH' : null,
        };
        tx.putEvidence(doc, 'create');
        return {
          ...t,
          eventType: input.kind === 'SELF_REPORT' ? t.eventType : `EVIDENCE_${status}`,
          payload: { ...t.payload, evidenceId: input.evidenceId, kind: input.kind, reasons },
        };
      },
      { simulation: input.simulation },
    );
  }

  /**
   * A named verifier decides on a candidate or conflicted record. Verifying
   * requires a cited source and a reason; a patient's own statement can never
   * be verified this way (MVP spec §03).
   */
  async attestEvidence(
    ctx: ActorContext,
    req: CommandRequest<{
      evidenceId: string;
      decision: 'VERIFY' | 'REJECT';
      reason: string;
      sourceRef: string;
    }>,
  ) {
    if (!(ctx.actorType === 'STAFF' && ctx.roles.includes('VERIFIER')))
      throw new DomainError('FORBIDDEN', 'ONLY_VERIFIER_CAN_ATTEST');
    const input = req.input;
    return this.execute(ctx, 'attestEvidence', req, async (c, tx, now) => {
      const ev = await this.load(tx.getEvidence(input.evidenceId), 'EVIDENCE');
      if (ev.caseId !== c.caseId) throw notFound('EVIDENCE');
      if (!input.reason.trim()) throw guardFailed('REASON_REQUIRED');
      if (ev.status !== 'CANDIDATE' && ev.status !== 'CONFLICTED' && ev.status !== 'SELF_REPORTED')
        throw guardFailed('EVIDENCE_ALREADY_DECIDED');
      let t: T.Transition;
      if (input.decision === 'VERIFY') {
        if (ev.kind === 'SELF_REPORT') throw guardFailed('SELF_REPORT_NOT_INDEPENDENT');
        const sourceRef = input.sourceRef.trim() || ev.sourceRef;
        // Attesting the conflicted record itself is the explicit human resolution of that conflict.
        const resolving =
          ev.status === 'CONFLICTED' ? ({ ...c, evidenceState: 'UNDER_REVIEW' } as Case) : c;
        t = T.verifyCompletion(
          resolving,
          {
            kind: 'STAFF_ATTESTATION',
            evidenceId: ev.evidenceId,
            occurredAt: ev.occurredAt,
            sourceRef,
            verifierId: ctx.actorId,
            reason: input.reason,
          },
          now,
        );
      } else {
        t = T.recordEvidenceReview(c, {
          evidenceId: ev.evidenceId,
          result: 'REJECTED',
          reasonCode: 'REJECTED_BY_VERIFIER',
        });
      }
      tx.putEvidence(
        {
          evidenceId: ev.evidenceId,
          status: input.decision === 'VERIFY' ? 'VERIFIED' : 'REJECTED',
          decidedBy: ctx.actorId,
          decidedAt: now.toISOString(),
          decisionReason: input.reason,
        },
        'merge',
      );
      return {
        ...t,
        payload: {
          ...t.payload,
          evidenceId: ev.evidenceId,
          decision: input.decision,
          reason: input.reason,
        },
      };
    });
  }

  resolveHandoff(
    ctx: ActorContext,
    req: CommandRequest<{ resolution: string; resumeAutomation: boolean }>,
  ) {
    return this.execute(ctx, 'resolveHandoff', req, (c) =>
      T.resolveHandoff(c, { staffId: ctx.actorId, ...req.input }),
    );
  }

  cancelCase(ctx: ActorContext, req: CommandRequest<{ reason: string }>) {
    return this.execute(ctx, 'cancelCase', req, (c) => T.cancelCase(c, req.input));
  }

  reopenCase(ctx: ActorContext, req: CommandRequest<{ reason: string }>) {
    return this.execute(ctx, 'reopenCase', req, (c) => T.reopenCase(c, req.input));
  }
}
