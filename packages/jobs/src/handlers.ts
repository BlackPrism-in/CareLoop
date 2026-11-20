import type { Firestore } from 'firebase-admin/firestore';
import type { Case } from '@careloop/contracts';
import type { BookingAdapter, ReservationResult } from '@careloop/adapters';
import {
  approvalIsCurrent,
  DomainError,
  tenantCollection,
  tenantRecord,
  type ActorContext,
  type CaseCommands,
  type CommandResult,
} from '@careloop/domain';
import type { Logger } from '@careloop/observability';
import { PermanentError, TransientError, type JobHandler } from './runner';
import type { BookingDoc, BookingStatus, OutboxDoc } from './types';

export interface HandlerDeps {
  db: Firestore;
  commands: CaseCommands;
  booking: BookingAdapter;
  log: Logger;
  clock?: () => Date;
}

type Base = { caseId: string; expectedVersion: number; idempotencyKey: string };

/**
 * Handlers for outbox kinds (MVP spec §16–17). Each re-reads the case and
 * re-checks eligibility at execution time. Provider calls happen here, never
 * inside a Firestore transaction; their outcomes reach the case only through
 * domain commands with a per-job idempotency key.
 */
export function createHandlers(deps: HandlerDeps): Partial<Record<OutboxDoc['kind'], JobHandler>> {
  const clock = deps.clock ?? (() => new Date());
  const { db, commands, booking } = deps;

  const system = (tenantId: string, o: OutboxDoc): ActorContext => ({
    tenantId,
    actorType: 'SYSTEM',
    actorId: 'worker',
    roles: [],
    correlationId: o.correlationId,
  });

  async function readCase(tenantId: string, caseId: string): Promise<Case> {
    const snap = await db.doc(tenantRecord(tenantId, 'cases', caseId)).get();
    if (!snap.exists) throw new PermanentError('CASE_NOT_FOUND');
    return snap.data() as Case;
  }

  /**
   * Runs a domain command for this job step. The key is unique to the job and
   * step, so "key reused" means an earlier attempt already applied it. A guard
   * failure means the case moved on: the side effect is stale, not an error.
   */
  async function command(
    tenantId: string,
    o: OutboxDoc,
    step: string,
    run: (ctx: ActorContext, base: Base) => Promise<CommandResult>,
  ): Promise<{ applied: boolean; result?: CommandResult; reason?: string }> {
    const c = await readCase(tenantId, o.caseId);
    try {
      const result = await run(system(tenantId, o), {
        caseId: c.caseId,
        expectedVersion: c.version,
        idempotencyKey: `job:${o.outboxId}:${step}`,
      });
      return { applied: true, result };
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      if (e.code === 'VERSION_CONFLICT') throw new TransientError('VERSION_CONFLICT');
      if (e.code === 'IDEMPOTENCY_KEY_REUSED') return { applied: true, reason: 'ALREADY_APPLIED' };
      if (e.code === 'DOMAIN_GUARD_FAILED') return { applied: false, reason: e.reason };
      throw new PermanentError(e.reason);
    }
  }

  async function putBooking(
    tenantId: string,
    id: string,
    patch: Partial<BookingDoc> & { status: BookingStatus },
    init?: Omit<BookingDoc, 'status' | 'createdAt' | 'updatedAt'>,
  ) {
    const ref = db.doc(tenantRecord(tenantId, 'bookings', id));
    const ts = clock().toISOString();
    await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (snap.exists) t.update(ref, { ...patch, updatedAt: ts });
      else if (init) t.set(ref, { ...init, ...patch, createdAt: ts, updatedAt: ts });
    });
  }

  async function applyReservation(
    tenantId: string,
    o: OutboxDoc,
    bookingId: string,
    r: ReservationResult,
    step: string,
  ) {
    switch (r.status) {
      case 'CONFIRMED': {
        await putBooking(tenantId, bookingId, {
          status: 'CONFIRMED',
          externalRef: r.externalRef,
          startsAt: r.startsAt,
          location: r.location,
          simulation: r.simulation,
          lastReconciledAt: clock().toISOString(),
        });
        const cmd = await command(tenantId, o, `${step}-confirm`, (ctx, base) =>
          commands.confirmBooking(ctx, {
            ...base,
            input: {
              externalRef: r.externalRef,
              startsAt: r.startsAt,
              adapter: booking.kind,
              simulation: r.simulation,
            },
          }),
        );
        if (!cmd.applied) {
          // The case moved on (e.g. cancelled) while the provider reserved: release the slot.
          await booking.cancel(
            { tenantId, operationId: bookingId, correlationId: o.correlationId },
            { externalRef: r.externalRef },
          );
          await putBooking(tenantId, bookingId, {
            status: 'CANCELLED',
            reason: `RELEASED_${cmd.reason}`,
          });
          return { status: 'DONE' as const, result: { outcome: 'RELEASED', reason: cmd.reason } };
        }
        return {
          status: 'DONE' as const,
          result: { outcome: 'CONFIRMED', externalRef: r.externalRef },
        };
      }
      case 'CONFLICT':
      case 'NOT_FOUND': {
        const reason = r.status === 'CONFLICT' ? r.reason : 'NOT_RESERVED';
        await putBooking(tenantId, bookingId, { status: 'REJECTED', reason });
        await command(tenantId, o, `${step}-reject`, (ctx, base) =>
          commands.recordBookingRejected(ctx, {
            ...base,
            input: { reason, operationId: bookingId },
          }),
        );
        return { status: 'DONE' as const, result: { outcome: 'REJECTED', reason } };
      }
      case 'PENDING_STAFF':
        await putBooking(tenantId, bookingId, { status: 'PENDING_STAFF' });
        return { status: 'DONE' as const, result: { outcome: 'PENDING_STAFF' } };
      case 'UNKNOWN':
        await putBooking(tenantId, bookingId, { status: 'UNKNOWN' });
        await command(tenantId, o, `${step}-unknown`, (ctx, base) =>
          commands.markBookingUnknown(ctx, { ...base, input: { operationId: bookingId } }),
        );
        return { status: 'DONE' as const, result: { outcome: 'UNKNOWN' } };
    }
  }

  const bookingRequest: JobHandler = async ({ tenantId, outbox: o }) => {
    const bookingId = String(o.payload.operationId);
    const slotId = String(o.payload.slotId);
    const c = await readCase(tenantId, o.caseId);
    if (c.bookingState !== 'REQUESTED')
      return { status: 'SKIPPED', result: { reason: `BOOKING_STATE_${c.bookingState}` } };

    await putBooking(
      tenantId,
      bookingId,
      { status: 'REQUESTED' },
      {
        bookingId,
        caseId: c.caseId,
        operationId: bookingId,
        adapter: booking.kind,
        slotId,
        externalRef: null,
        startsAt: null,
        location: null,
        reason: null,
        simulation: booking.kind === 'sandbox',
        confirmedBy: null,
        lastReconciledAt: null,
      },
    );

    // Execution-time re-check: approval, suppression and workflow state.
    const eligible =
      c.workflowState === 'AWAITING_BOOKING' &&
      approvalIsCurrent(c) &&
      !['OPTED_OUT', 'DECLINED'].includes(c.outreachDisposition);
    if (!eligible) {
      await putBooking(tenantId, bookingId, { status: 'REJECTED', reason: 'NO_LONGER_ELIGIBLE' });
      await command(tenantId, o, 'ineligible', (ctx, base) =>
        commands.recordBookingRejected(ctx, {
          ...base,
          input: { reason: 'NO_LONGER_ELIGIBLE', operationId: bookingId },
        }),
      );
      return { status: 'DONE', result: { outcome: 'REJECTED', reason: 'NO_LONGER_ELIGIBLE' } };
    }

    let r: ReservationResult;
    try {
      r = await booking.reserve(
        { tenantId, operationId: bookingId, correlationId: o.correlationId },
        { siteId: c.siteId, slotId, caseId: c.caseId, actionType: c.actionType },
      );
    } catch (e) {
      // The provider may have acted before failing: never assume it didn't.
      deps.log.warn('booking adapter error treated as UNKNOWN', {
        caseId: c.caseId,
        error: (e as Error).message,
      });
      r = { status: 'UNKNOWN' };
    }
    return applyReservation(tenantId, o, bookingId, r, 'reserve');
  };

  const bookingReconcile: JobHandler = async ({ tenantId, outbox: o }) => {
    const c = await readCase(tenantId, o.caseId);
    if (o.payload.reason === 'CASE_CANCELLED') {
      // Release any live reservation for a withdrawn obligation.
      const snap = await db
        .collection(tenantCollection(tenantId, 'bookings'))
        .where('caseId', '==', c.caseId)
        .get();
      let released = 0;
      for (const d of snap.docs) {
        const b = d.data() as BookingDoc;
        const ctx = { tenantId, operationId: b.operationId, correlationId: o.correlationId };
        let ref = b.externalRef;
        if (!ref && (b.status === 'UNKNOWN' || b.status === 'REQUESTED')) {
          const r = await booking.reconcile(ctx);
          if (r.status === 'CONFIRMED') ref = r.externalRef;
        }
        if (ref && b.status !== 'CANCELLED' && b.status !== 'REJECTED') {
          const r = await booking.cancel(ctx, { externalRef: ref });
          if (r.status === 'UNKNOWN') throw new TransientError('CANCEL_UNKNOWN');
          await putBooking(tenantId, b.bookingId, {
            status: r.status === 'CANCELLED' ? 'CANCELLED' : 'CANCEL_PENDING',
            externalRef: ref,
            reason: 'CASE_CANCELLED',
          });
          released++;
        }
      }
      return { status: 'DONE', result: { outcome: 'RELEASED', released } };
    }

    const bookingId = String(o.payload.operationId);
    if (c.bookingState !== 'UNKNOWN')
      return { status: 'SKIPPED', result: { reason: `BOOKING_STATE_${c.bookingState}` } };
    let r: ReservationResult;
    try {
      r = await booking.reconcile({
        tenantId,
        operationId: bookingId,
        correlationId: o.correlationId,
      });
    } catch (e) {
      throw new TransientError(`RECONCILE_ERROR ${(e as Error).message}`);
    }
    if (r.status === 'UNKNOWN' || r.status === 'PENDING_STAFF')
      throw new TransientError('STILL_UNKNOWN');
    return applyReservation(tenantId, o, bookingId, r, 'reconcile');
  };

  const bookingCancel: JobHandler = async ({ tenantId, outbox: o }) => {
    const externalRef = String(o.payload.externalRef);
    const snap = await db
      .collection(tenantCollection(tenantId, 'bookings'))
      .where('caseId', '==', o.caseId)
      .where('externalRef', '==', externalRef)
      .limit(1)
      .get();
    const b = snap.docs[0]?.data() as BookingDoc | undefined;
    if (!b) throw new PermanentError('BOOKING_NOT_FOUND');
    let r: { status: 'CANCELLED' | 'PENDING' | 'UNKNOWN' };
    try {
      r = await booking.cancel(
        { tenantId, operationId: b.operationId, correlationId: o.correlationId },
        { externalRef },
      );
    } catch (e) {
      throw new TransientError(`CANCEL_ERROR ${(e as Error).message}`);
    }
    if (r.status === 'UNKNOWN') throw new TransientError('CANCEL_UNKNOWN');
    if (r.status === 'PENDING') {
      await putBooking(tenantId, b.bookingId, { status: 'CANCEL_PENDING' });
      return { status: 'DONE', result: { outcome: 'CANCEL_PENDING_STAFF' } };
    }
    await putBooking(tenantId, b.bookingId, {
      status: 'CANCELLED',
      reason: 'CANCELLED_ON_REQUEST',
    });
    const cmd = await command(tenantId, o, 'cancelled', (ctx, base) =>
      commands.recordBookingCancelled(ctx, { ...base, input: { externalRef } }),
    );
    return { status: 'DONE', result: { outcome: 'CANCELLED', caseUpdated: cmd.applied } };
  };

  return {
    BOOKING_REQUEST: bookingRequest,
    BOOKING_RECONCILE: bookingReconcile,
    BOOKING_CANCEL: bookingCancel,
    // Phase 4 connects contact attempts to the voice gateway; nothing is dialled here.
    CONTACT_ATTEMPT: async () => ({
      status: 'SKIPPED',
      result: { reason: 'VOICE_GATEWAY_NOT_CONNECTED' },
    }),
    // Phase 5 adds staff notifications; the handoff itself is already visible in the queue.
    HANDOFF_NOTIFY: async () => ({
      status: 'SKIPPED',
      result: { reason: 'NOTIFICATIONS_NOT_CONNECTED' },
    }),
    // Suppression is enforced by execution-time checks in every handler and command.
    SUPPRESS_PENDING_WORK: async () => ({
      status: 'DONE',
      result: { note: 'execution-time checks enforce suppression' },
    }),
  };
}
