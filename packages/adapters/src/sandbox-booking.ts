import type { Firestore } from 'firebase-admin/firestore';
import type { ActionType, Slot } from '@careloop/contracts';
import { tenantCollection, tenantRecord } from '@careloop/domain';
import type { AdapterContext, AvailableSlot, BookingAdapter, ReservationResult } from './index';

export interface SandboxReservation {
  externalRef: string;
  operationId: string;
  caseId: string;
  slotId: string;
  startsAt: string;
  location: string;
  status: 'RESERVED' | 'CANCELLED';
  simulation: true;
  createdAt: string;
  cancelledAt: string | null;
}

/** Fault injection for tests and the demo's failure scenarios. */
export type SandboxFault = 'NONE' | 'TIMEOUT_AFTER_COMMIT' | 'TIMEOUT_BEFORE_COMMIT';

const refFor = (operationId: string) => `sbx_${operationId.slice(0, 20)}`;

/**
 * A real transactional calendar over Firestore `slots` + `sandbox_reservations`
 * (MVP spec §17). Availability comes only from slot documents, never from a
 * model. Every result is labelled simulation=true.
 */
export class SandboxBookingAdapter implements BookingAdapter {
  readonly kind = 'sandbox' as const;
  fault: SandboxFault = 'NONE';

  constructor(
    private readonly db: Firestore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listSlots(
    ctx: AdapterContext,
    q: { siteId: string; actionType: ActionType; from: string; to: string },
  ): Promise<AvailableSlot[]> {
    const snap = await this.db
      .collection(tenantCollection(ctx.tenantId, 'slots'))
      .where('siteId', '==', q.siteId)
      .where('actionType', '==', q.actionType)
      .where('startsAt', '>=', q.from)
      .where('startsAt', '<=', q.to)
      .orderBy('startsAt')
      .limit(20)
      .get();
    return snap.docs
      .map((d) => d.data() as Slot)
      .filter((s) => s.reserved < s.capacity)
      .map((s) => ({
        slotId: s.slotId,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        location: s.location,
      }));
  }

  async reserve(
    ctx: AdapterContext,
    req: { siteId: string; slotId: string; caseId: string; actionType: ActionType },
  ): Promise<ReservationResult> {
    if (this.fault === 'TIMEOUT_BEFORE_COMMIT') return { status: 'UNKNOWN' };
    const externalRef = refFor(ctx.operationId);
    const resRef = this.db.doc(tenantRecord(ctx.tenantId, 'sandbox_reservations', externalRef));
    const slotRef = this.db.doc(tenantRecord(ctx.tenantId, 'slots', req.slotId));
    const now = this.clock();
    const result = await this.db.runTransaction<ReservationResult>(async (t) => {
      const [existing, slotSnap] = await Promise.all([t.get(resRef), t.get(slotRef)]);
      if (existing.exists) {
        const r = existing.data() as SandboxReservation;
        // Replay of the same operation returns the same booking.
        return r.status === 'RESERVED'
          ? {
              status: 'CONFIRMED',
              externalRef: r.externalRef,
              startsAt: r.startsAt,
              location: r.location,
              simulation: true,
            }
          : { status: 'CONFLICT', reason: 'SLOT_TAKEN' };
      }
      if (!slotSnap.exists) return { status: 'CONFLICT', reason: 'SLOT_INCOMPATIBLE' };
      const slot = slotSnap.data() as Slot;
      if (
        slot.siteId !== req.siteId ||
        slot.actionType !== req.actionType ||
        Date.parse(slot.startsAt) <= now.getTime()
      ) {
        return { status: 'CONFLICT', reason: 'SLOT_INCOMPATIBLE' };
      }
      if (slot.reserved >= slot.capacity) return { status: 'CONFLICT', reason: 'SLOT_TAKEN' };
      const reservation: SandboxReservation = {
        externalRef,
        operationId: ctx.operationId,
        caseId: req.caseId,
        slotId: slot.slotId,
        startsAt: slot.startsAt,
        location: slot.location,
        status: 'RESERVED',
        simulation: true,
        createdAt: now.toISOString(),
        cancelledAt: null,
      };
      t.update(slotRef, { reserved: slot.reserved + 1 });
      t.create(resRef, reservation);
      return {
        status: 'CONFIRMED',
        externalRef,
        startsAt: slot.startsAt,
        location: slot.location,
        simulation: true,
      };
    });
    // The provider did the work but the acknowledgment was lost.
    if (this.fault === 'TIMEOUT_AFTER_COMMIT') return { status: 'UNKNOWN' };
    return result;
  }

  async reconcile(ctx: AdapterContext): Promise<ReservationResult> {
    const snap = await this.db
      .doc(tenantRecord(ctx.tenantId, 'sandbox_reservations', refFor(ctx.operationId)))
      .get();
    if (!snap.exists) return { status: 'NOT_FOUND' };
    const r = snap.data() as SandboxReservation;
    return r.status === 'RESERVED'
      ? {
          status: 'CONFIRMED',
          externalRef: r.externalRef,
          startsAt: r.startsAt,
          location: r.location,
          simulation: true,
        }
      : { status: 'NOT_FOUND' };
  }

  async cancel(
    ctx: AdapterContext,
    req: { externalRef: string },
  ): Promise<{ status: 'CANCELLED' | 'PENDING' | 'UNKNOWN' }> {
    const resRef = this.db.doc(tenantRecord(ctx.tenantId, 'sandbox_reservations', req.externalRef));
    await this.db.runTransaction(async (t) => {
      const snap = await t.get(resRef);
      if (!snap.exists) return;
      const r = snap.data() as SandboxReservation;
      if (r.status === 'CANCELLED') return; // idempotent
      const slotRef = this.db.doc(tenantRecord(ctx.tenantId, 'slots', r.slotId));
      const slot = (await t.get(slotRef)).data() as Slot | undefined;
      if (slot) t.update(slotRef, { reserved: Math.max(0, slot.reserved - 1) });
      t.update(resRef, { status: 'CANCELLED', cancelledAt: this.clock().toISOString() });
    });
    return { status: 'CANCELLED' };
  }
}
