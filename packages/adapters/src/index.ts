import type { ActionType, NormalizedProviderEvent } from '@careloop/contracts';

/**
 * Provider boundaries (MVP spec §08). Each has a sandbox/manual implementation
 * first; contracted providers replace them without changing the case lifecycle.
 * Every call passes the same operationId so retries are idempotent.
 */

export interface AdapterContext {
  tenantId: string;
  operationId: string;
  correlationId: string;
}

export interface AvailableSlot {
  slotId: string;
  startsAt: string;
  endsAt: string;
  location: string;
}

export type ReservationResult =
  | {
      status: 'CONFIRMED';
      externalRef: string;
      startsAt: string;
      location: string;
      simulation: boolean;
    }
  | { status: 'CONFLICT'; reason: 'SLOT_TAKEN' | 'SLOT_INCOMPATIBLE' }
  /** Timeout / lost acknowledgment: the side effect may have happened. Reconcile, never blindly retry. */
  | { status: 'UNKNOWN' }
  /** Manual adapter: a staff booking task was created; case stays AWAITING_BOOKING. */
  | { status: 'PENDING_STAFF'; taskId: string }
  /** Reconciliation only: the provider has no reservation for this operation, so a new request is safe. */
  | { status: 'NOT_FOUND' };

export interface BookingAdapter {
  readonly kind: 'sandbox' | 'manual' | 'provider';
  listSlots(
    ctx: AdapterContext,
    q: { siteId: string; actionType: ActionType; from: string; to: string },
  ): Promise<AvailableSlot[]>;
  /** Idempotent per ctx.operationId: replaying the same operation returns the same reservation. */
  reserve(
    ctx: AdapterContext,
    req: { siteId: string; slotId: string; caseId: string; actionType: ActionType },
  ): Promise<ReservationResult>;
  cancel(
    ctx: AdapterContext,
    req: { externalRef: string },
  ): Promise<{ status: 'CANCELLED' | 'PENDING' | 'UNKNOWN' }>;
  /** Looks up ctx.operationId to resolve an UNKNOWN outcome. */
  reconcile(ctx: AdapterContext): Promise<ReservationResult>;
}

export interface MessagingAdapter {
  readonly kind: 'simulated' | 'provider';
  /** Only pre-approved templates; never free text with health context. */
  sendTemplate(
    ctx: AdapterContext,
    req: { patientId: string; templateId: string; params: Record<string, string> },
  ): Promise<{ status: 'SENT' | 'SIMULATED' | 'FAILED'; providerRef?: string }>;
}

export interface IdentityAdapter {
  readonly kind: 'supervised-demo' | 'provider';
  /** Assurance is bound to one interaction and purpose; it is not a permanent case state. */
  verify(
    ctx: AdapterContext,
    req: { patientId: string; interactionId: string; response: string },
  ): Promise<{ assurance: 'VERIFIED' | 'FAILED' | 'SIMULATED'; ref: string }>;
}

export interface EvidenceSourceAdapter {
  readonly kind: 'sandbox' | 'provider';
  /** Verifies the provider signature over the raw body and normalizes. Tenant comes from account mapping, not payload. */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): Promise<NormalizedProviderEvent>;
}

export * from './sandbox-booking';
export * from './manual-booking';
export * from './whatsapp';
