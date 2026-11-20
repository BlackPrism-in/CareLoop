import type { ActionType } from '@careloop/contracts';
import type { AdapterContext, AvailableSlot, BookingAdapter, ReservationResult } from './index';

/**
 * No calendar integration: every request becomes a staff booking task. The
 * case stays AWAITING_BOOKING until a staff member enters the real external
 * reference and confirmed time (MVP spec §17 "Manual adapter"). Staff
 * cancellations are done outside CareLoop and then recorded.
 */
export class ManualBookingAdapter implements BookingAdapter {
  readonly kind = 'manual' as const;

  async listSlots(
    _ctx: AdapterContext,
    _q: { siteId: string; actionType: ActionType; from: string; to: string },
  ): Promise<AvailableSlot[]> {
    return []; // staff choose the time; the patient states a preferred window
  }

  async reserve(ctx: AdapterContext): Promise<ReservationResult> {
    return { status: 'PENDING_STAFF', taskId: ctx.operationId };
  }

  async reconcile(): Promise<ReservationResult> {
    return { status: 'UNKNOWN' }; // only staff can tell; leave it with them
  }

  async cancel(): Promise<{ status: 'CANCELLED' | 'PENDING' | 'UNKNOWN' }> {
    return { status: 'PENDING' }; // staff cancel externally, then record it
  }
}
