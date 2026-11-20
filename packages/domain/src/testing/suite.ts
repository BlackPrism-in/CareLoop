import { beforeEach, describe, expect, it } from 'vitest';
import type { Case, EventEnvelope } from '@careloop/contracts';
import { DomainError } from '../errors';
import { caseEvents, tenantCollection, tenantDoc, tenantRecord } from '../paths';
import { CaseCommands, type ServiceConfig } from '../service';
import type { OutboxRecord, Store } from '../store';
import {
  AGENT,
  ALL_CHECKS,
  auditor,
  coordinator,
  DEFAULT_CONFIG,
  Driver,
  newCase,
  owner,
  reviewer,
  seedWorld,
  START,
  SYSTEM,
  T1,
  verifier,
} from './world';

/** A storage backend under test. The same suite runs against memory and the Firestore emulator. */
export interface TestBackend {
  store: Store;
  reset(): Promise<void>;
  seed(path: string, data: object): unknown;
  read<X>(path: string): Promise<X | undefined>;
  list<X>(collectionPath: string): Promise<X[]>;
}

async function rejects(p: Promise<unknown>, reason: string): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).reason).toBe(reason);
    return e as DomainError;
  }
  throw new Error(`expected rejection ${reason}`);
}

export function commandSuite(name: string, backend: () => TestBackend) {
  describe(`case commands — ${name}`, () => {
    let b: TestBackend;
    let now: Date;
    let svc: CaseCommands;
    let d: Driver;
    const make = (config: Partial<ServiceConfig> = {}) =>
      new CaseCommands({
        store: b.store,
        config: { ...DEFAULT_CONFIG, ...config },
        clock: () => now,
      });
    const getCase = (id = 'CL-1') => b.read<Case>(tenantRecord(T1, 'cases', id));
    const events = (id = 'CL-1') => b.list<EventEnvelope>(caseEvents(T1, id));
    const outbox = () => b.list<OutboxRecord>(tenantCollection(T1, 'outbox'));

    beforeEach(async () => {
      b = backend();
      await b.reset();
      await seedWorld(b);
      now = new Date(START);
      svc = make();
      d = new Driver(svc);
    });

    // ---- happy path ----------------------------------------------------------

    it('moves one obligation from draft to verified completion with a full event trail', async () => {
      await d.toBooked();
      now = new Date('2026-11-23T12:00:00Z');
      d.track(await svc.awaitEvidence(SYSTEM, d.req({ trigger: 'OCCURRENCE_PASSED' as const })));
      const done = d.track(
        await svc.verifyCompletion(
          verifier,
          d.req({
            kind: 'STAFF_ATTESTATION' as const,
            evidenceId: 'ev1',
            occurredAt: '2026-11-23T11:05:00Z',
            sourceRef: 'clinic_register_p12',
            reason: 'Seen in clinic register',
          }),
        ),
      );
      expect(done.workflowState).toBe('COMPLETED_VERIFIED');
      expect(done.evidenceState).toBe('VERIFIED');
      const types = (await events()).map((e) => e.eventType);
      expect(types).toEqual([
        'CASE_CREATED',
        'CASE_APPROVED',
        'CONTACT_DISPATCHED',
        'PATIENT_REQUEST_RECORDED',
        'BOOKING_REQUESTED',
        'BOOKING_CONFIRMED',
        'AWAITING_EVIDENCE',
        'COMPLETION_VERIFIED',
      ]);
      const evs = await events();
      evs.forEach((e, i) => {
        expect(e.nextVersion).toBe(i + 1);
        expect(e.tenantId).toBe(T1);
        expect(e.simulation).toBe(true);
      });
    });

    // ---- MVP-01 create -------------------------------------------------------

    it('MVP-01: sets tenant/creator server-side and starts as a paused DRAFT', async () => {
      const r = await d.create();
      expect(r.workflowState).toBe('DRAFT');
      expect(r.automationPausedReason).toBe('REVIEW_REQUIRED');
      const c = await getCase();
      expect(c?.createdBy).toBe('u_coord');
      expect(c?.approvalRevision).toBe(0);
    });

    it('MVP-01: a duplicate source + action returns the existing case with a warning', async () => {
      await d.create();
      const dup = await svc.createCase(coordinator, {
        idempotencyKey: 'other',
        input: newCase({ caseId: 'CL-2' }),
      });
      expect(dup.caseId).toBe('CL-1');
      expect(dup.warnings).toEqual(['DUPLICATE_SOURCE_ACTION']);
      expect(await getCase('CL-2')).toBeUndefined();
      // A different obligation from the same source is a separate case.
      const test = await svc.createCase(coordinator, {
        idempotencyKey: 'k3',
        input: newCase({ caseId: 'CL-3', actionType: 'ORDERED_TEST' }),
      });
      expect(test.caseId).toBe('CL-3');
      expect(test.warnings).toEqual([]);
    });

    it('MVP-01: cross-tenant references look like not-found', async () => {
      await rejects(
        svc.createCase(coordinator, {
          idempotencyKey: 'x',
          input: newCase({ patientId: 'p_other', consentId: 'c_other' }),
        }),
        'PATIENT_NOT_FOUND',
      );
      await rejects(
        svc.approve(reviewer, {
          caseId: 'CL-404',
          expectedVersion: 1,
          idempotencyKey: 'y',
          input: { sourceAuthorityRef: 'o', checkedFields: [...ALL_CHECKS] },
        }),
        'CASE_NOT_FOUND',
      );
    });

    it('MVP-01: rejects invalid input without writing anything', async () => {
      await rejects(
        svc.createCase(coordinator, {
          idempotencyKey: 'x',
          input: newCase({ caseId: 'bad/id', dueAt: 'tomorrow' }),
        }),
        'VALIDATION_FAILED',
      );
      expect(await b.list(tenantCollection(T1, 'cases'))).toEqual([]);
    });

    // ---- MVP-02 approval -----------------------------------------------------

    it('MVP-02: only a reviewer approves; owner, coordinator, agent and auditor cannot', async () => {
      await d.create();
      const input = { sourceAuthorityRef: 'order_1', checkedFields: [...ALL_CHECKS] };
      for (const actor of [owner, coordinator, auditor]) {
        await rejects(svc.approve(actor, d.req(input)), 'ROLE_CANNOT_approve');
      }
      await rejects(svc.approve(AGENT, d.req(input)), 'AGENT_CANNOT_approve');
      const r = await d.approve();
      expect(r.workflowState).toBe('READY');
      const c = await getCase();
      expect(c?.approvedBy).toBe('u_rev');
      expect(c?.approvalRevision).toBe(1);
      expect(c?.approvalHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('MVP-02: an incomplete checklist or unconfirmed adult eligibility blocks approval', async () => {
      await d.create();
      await rejects(
        svc.approve(
          reviewer,
          d.req({ sourceAuthorityRef: 'o', checkedFields: ['patient', 'action'] as const }),
        ),
        'APPROVAL_CHECKLIST_INCOMPLETE',
      );
      const minor = new Driver(svc, 'CL-M');
      await minor.create({ patientId: 'p_minor', consentId: 'c_minor', sourceId: 's2' });
      await rejects(minor.approve(), 'ADULT_ELIGIBILITY_NOT_CONFIRMED');
    });

    it('a material edit after approval invalidates it and blocks outreach until re-approved', async () => {
      await d.create();
      await d.approve();
      const edited = d.track(
        await svc.editDraft(coordinator, d.req({ dueAt: '2026-11-29T12:30:00Z' })),
      );
      expect(edited.workflowState).toBe('DRAFT');
      expect(edited.automationPausedReason).toBe('REVIEW_REQUIRED');
      await rejects(d.dispatch(), 'INVALID_STATE_FOR_DISPATCH');
      const again = await d.approve();
      expect(again.workflowState).toBe('READY');
      expect((await getCase())?.approvalRevision).toBe(2);
      expect((await events()).map((e) => e.eventType)).toContain(
        'CASE_EDITED_APPROVAL_INVALIDATED',
      );
    });

    // ---- MVP-03 dispatch -----------------------------------------------------

    it('MVP-03: no outreach without current approval', async () => {
      await d.create();
      await rejects(d.dispatch(), 'INVALID_STATE_FOR_DISPATCH');
    });

    it('MVP-03: consent revoked after approval blocks dispatch at execution time', async () => {
      await d.create();
      await d.approve();
      await b.seed(tenantRecord(T1, 'consents', 'c1'), {
        ...(await b.read<object>(tenantRecord(T1, 'consents', 'c1'))),
        revokedAt: '2026-11-21T04:00:00Z',
        version: 2,
      });
      await rejects(d.dispatch(), 'CONSENT_NOT_ACTIVE_FOR_CHANNEL');
      expect((await getCase())?.contactAttempts).toBe(0);
    });

    it('MVP-03: respects the outreach kill switch, site pause and contact window', async () => {
      await d.create();
      await d.approve();
      const tenantPath = tenantDoc(T1);
      const tenant = (await b.read<Record<string, unknown>>(tenantPath))!;
      const killed = make({ outreachEnabled: false });
      // A real (non-simulation) tenant is blocked by the kill switch on every channel.
      await b.seed(tenantPath, { ...tenant, simulation: false });
      await rejects(
        killed.dispatchContact(SYSTEM, d.req({ channel: 'BROWSER_VOICE' as const })),
        'OUTREACH_DISABLED',
      );
      // Site pause blocks even when outreach is enabled.
      await b.seed(tenantPath, { ...tenant, outreachPaused: true });
      await rejects(d.dispatch(), 'SITE_PAUSED');
      await b.seed(tenantPath, tenant);
      now = new Date('2026-11-21T15:00:00Z'); // 20:30 IST
      await rejects(d.dispatch(), 'OUTSIDE_CONTACT_WINDOW');
      now = new Date(START);
      await rejects(
        svc.dispatchContact(SYSTEM, d.req({ channel: 'WHATSAPP' as const })),
        'CONSENT_NOT_ACTIVE_FOR_CHANNEL',
      );
    });

    it('a synthetic tenant may run a simulated browser session with outreach disabled, but nothing else', async () => {
      await d.create();
      await d.approve();
      const killed = make({ outreachEnabled: false });
      await b.seed(tenantRecord(T1, 'consents', 'c1'), {
        ...(await b.read<object>(tenantRecord(T1, 'consents', 'c1'))),
        channels: ['BROWSER_VOICE', 'WHATSAPP'],
      });
      await rejects(
        killed.dispatchContact(SYSTEM, d.req({ channel: 'WHATSAPP' as const })),
        'OUTREACH_DISABLED',
      );
      const r = d.track(
        await killed.dispatchContact(SYSTEM, d.req({ channel: 'BROWSER_VOICE' as const })),
      );
      expect(r.workflowState).toBe('CONTACTING');
      expect((await events()).at(-1)?.simulation).toBe(true);
    });

    it('a rejected booking returns to scheduling; a late confirmation cannot resurrect a cancellation', async () => {
      await d.create();
      await d.approve();
      await d.dispatch();
      await d.patientBooks();
      await d.requestBooking();
      const rej = d.track(
        await svc.recordBookingRejected(SYSTEM, d.req({ reason: 'SLOT_TAKEN', operationId: 'op' })),
      );
      expect(rej.bookingState).toBe('NONE');
      expect(rej.workflowState).toBe('AWAITING_BOOKING');
      await d.requestBooking('slot_2');
      await d.confirmBooking();
      const cancelReq = d.track(
        await svc.requestBookingCancellation(
          coordinator,
          d.req({ externalRef: 'booking_1', reason: 'Patient asked' }),
        ),
      );
      expect(cancelReq.bookingState).toBe('CONFIRMED'); // not cancelled until the provider acknowledges
      expect((await outbox()).map((o) => o.kind)).toContain('BOOKING_CANCEL');
      const cancelled = d.track(
        await svc.recordBookingCancelled(SYSTEM, d.req({ externalRef: 'booking_1' })),
      );
      expect(cancelled.bookingState).toBe('CANCELLED');
      expect(cancelled.workflowState).toBe('AWAITING_BOOKING');
      // A delayed "confirmed" callback must not overwrite the newer cancellation.
      await rejects(d.confirmBooking(), 'NO_PENDING_BOOKING_REQUEST');
    });

    it('MVP-03: the attempt budget is enforced and exhausting it hands off to a human', async () => {
      await d.create();
      await d.approve();
      await d.dispatch();
      d.track(
        await svc.recordContactOutcome(
          SYSTEM,
          d.req({ outcome: 'RETRY_SCHEDULED' as const, audioSeconds: 20 }),
        ),
      );
      const second = await d.dispatch();
      expect(second.workflowState).toBe('CONTACTING');
      const out = d.track(
        await svc.recordContactOutcome(
          SYSTEM,
          d.req({ outcome: 'RETRY_SCHEDULED' as const, audioSeconds: 30 }),
        ),
      );
      expect(out.outreachDisposition).toBe('UNREACHABLE');
      expect(out.handoffState).toBe('PENDING');
      const c = await getCase();
      expect(c?.contactAttempts).toBe(2);
      expect(c?.audioSecondsUsed).toBe(50);
      expect(c?.workflowState).not.toBe('COMPLETED_VERIFIED');
    });

    it('a finished voice interaction records billed audio in any open state, and an outcome only while contacting', async () => {
      await d.create();
      await d.approve();
      await d.dispatch();
      const noAnswer = d.track(
        await svc.recordInteractionEnded(
          SYSTEM,
          d.req({ interactionId: 'i1', audioSeconds: 12, outcome: 'RETRY_SCHEDULED' as const }),
        ),
      );
      expect(noAnswer.outreachDisposition).toBe('RETRY_SCHEDULED');
      await d.dispatch();
      await d.patientBooks();
      await d.requestBooking();
      await d.confirmBooking();
      const after = d.track(
        await svc.recordInteractionEnded(
          SYSTEM,
          d.req({ interactionId: 'i2', audioSeconds: 95, outcome: 'REACHED' as const }),
        ),
      );
      expect(after.workflowState).toBe('BOOKED');
      expect((await getCase())?.audioSecondsUsed).toBe(107);
      expect((await events()).at(-1)?.eventType).toBe('INTERACTION_ENDED');
    });

    // ---- MVP-04/05 booking ---------------------------------------------------

    it('MVP-04: a booking request needs explicit patient confirmation of the slot', async () => {
      await d.create();
      await d.approve();
      await d.dispatch();
      await d.patientBooks();
      await rejects(
        svc.requestBooking(AGENT, d.req({ slotId: 'slot_1', patientConfirmedSlot: false })),
        'SLOT_NOT_CONFIRMED_BY_PATIENT',
      );
    });

    it('MVP-05: BOOKED only after an acknowledgment; UNKNOWN blocks a blind retry', async () => {
      await d.create();
      await d.approve();
      await d.dispatch();
      await d.patientBooks();
      const reqd = await d.requestBooking();
      expect(reqd.workflowState).toBe('AWAITING_BOOKING');
      expect(reqd.bookingState).toBe('REQUESTED');
      const outboxKinds = (await outbox()).map((o) => o.kind);
      expect(outboxKinds).toContain('BOOKING_REQUEST');

      const unknown = d.track(await svc.markBookingUnknown(SYSTEM, d.req({ operationId: 'op' })));
      expect(unknown.bookingState).toBe('UNKNOWN');
      await rejects(d.requestBooking('slot_2'), 'BOOKING_UNKNOWN_RECONCILE_FIRST');
      await rejects(
        svc.confirmBooking(
          SYSTEM,
          d.req({
            externalRef: ' ',
            startsAt: '2026-11-23T11:00:00Z',
            adapter: 'sandbox' as const,
            simulation: true,
          }),
        ),
        'RESERVATION_REFERENCE_REQUIRED',
      );
      const booked = await d.confirmBooking();
      expect(booked.workflowState).toBe('BOOKED');
      expect(booked.evidenceState).toBe('NONE');
    });

    it('an agent cannot confirm a booking or mark it unknown', async () => {
      await d.create();
      await d.approve();
      await d.dispatch();
      await d.patientBooks();
      await d.requestBooking();
      await rejects(
        svc.confirmBooking(
          AGENT,
          d.req({
            externalRef: 'b',
            startsAt: '2026-11-23T11:00:00Z',
            adapter: 'sandbox' as const,
            simulation: true,
          }),
        ),
        'AGENT_CANNOT_confirmBooking',
      );
    });

    // ---- MVP-06/07/11 exceptions ---------------------------------------------

    it('MVP-06/11: a handoff is created and acknowledged without completing the case', async () => {
      await d.create();
      await d.approve();
      await d.dispatch();
      const h = d.track(
        await svc.createHandoff(
          AGENT,
          d.req({
            reasonCode: 'MEDICAL_QUESTION',
            ownerId: 'u_coord',
            dueAt: '2026-11-21T08:00:00Z',
          }),
        ),
      );
      expect(h.handoffState).toBe('PENDING');
      expect(h.automationPausedReason).toBe('HANDOFF');
      await rejects(svc.acknowledgeHandoff(AGENT, d.req({})), 'AGENT_CANNOT_acknowledgeHandoff');
      const ack = d.track(await svc.acknowledgeHandoff(coordinator, d.req({})));
      expect(ack.handoffState).toBe('ACKNOWLEDGED');
      expect(ack.workflowState).toBe('CONTACTING');
      expect(ack.evidenceState).toBe('NONE');
      // Paused automation blocks contact while the handoff is open.
      d.track(
        await svc.recordContactOutcome(
          SYSTEM,
          d.req({ outcome: 'RETRY_SCHEDULED' as const, audioSeconds: 0 }),
        ),
      );
      await rejects(d.dispatch(), 'AUTOMATION_PAUSED_HANDOFF');
    });

    it('MVP-07: opt-out suppresses all further contact but does not cancel the obligation', async () => {
      await d.create();
      await d.approve();
      const r = d.track(await svc.optOut(AGENT, d.req({ channel: 'ALL' as const })));
      expect(r.outreachDisposition).toBe('OPTED_OUT');
      expect(r.workflowState).toBe('READY');
      await rejects(d.dispatch(), 'AUTOMATION_PAUSED_CONSENT');
      expect((await outbox()).map((o) => o.kind)).toContain('SUPPRESS_PENDING_WORK');
    });

    // ---- MVP-08/09 completion ------------------------------------------------

    it('MVP-09: nothing but verified evidence completes a case', async () => {
      await d.toBooked();
      // Self-report is recorded but stays separate.
      const self = d.track(
        await svc.recordSelfReport(AGENT, d.req({ statedOccurredAt: '2026-11-23T11:00:00Z' })),
      );
      expect(self.workflowState).toBe('BOOKED');
      expect(self.evidenceState).toBe('SELF_REPORTED');
      // A trusted event must come from the matcher, not an agent or a coordinator.
      const trusted = {
        kind: 'TRUSTED_EVENT' as const,
        evidenceId: 'e',
        occurredAt: '2026-11-21T04:00:00Z',
        sourceRef: 'x',
        simulation: true,
      };
      await rejects(
        svc.verifyCompletion(AGENT, d.req(trusted)),
        'TRUSTED_EVENT_MUST_COME_FROM_MATCHER',
      );
      const attest = {
        kind: 'STAFF_ATTESTATION' as const,
        evidenceId: 'e',
        occurredAt: '2026-11-21T04:59:00Z',
        sourceRef: 'register',
        reason: 'seen',
      };
      await rejects(svc.verifyCompletion(coordinator, d.req(attest)), 'ONLY_VERIFIER_CAN_ATTEST');
      // Evidence must post-date approval and not be in the future.
      await rejects(
        svc.verifyCompletion(verifier, d.req({ ...attest, occurredAt: '2026-11-20T00:00:00Z' })),
        'OCCURRED_BEFORE_APPROVAL',
      );
      await rejects(
        svc.verifyCompletion(verifier, d.req({ ...attest, occurredAt: '2026-11-30T00:00:00Z' })),
        'OCCURRENCE_IN_FUTURE',
      );
      expect((await getCase())?.workflowState).toBe('BOOKED');
    });

    it('MVP-08: conflicted evidence must be resolved before completion', async () => {
      await d.toBooked();
      d.track(
        await svc.recordEvidenceReview(
          verifier,
          d.req({
            evidenceId: 'e1',
            result: 'CONFLICTED' as const,
            reasonCode: 'PATIENT_REF_MISMATCH',
          }),
        ),
      );
      await rejects(
        svc.verifyCompletion(
          SYSTEM,
          d.req({
            kind: 'TRUSTED_EVENT' as const,
            evidenceId: 'e2',
            occurredAt: '2026-11-21T05:00:00Z',
            sourceRef: 'evt',
            simulation: true,
          }),
        ),
        'RESOLVE_CONFLICT_FIRST',
      );
    });

    it('completion elsewhere counts when independently verified, even without a booking', async () => {
      await d.create();
      await d.approve();
      now = new Date('2026-11-22T06:00:00Z');
      const r = await svc.verifyCompletion(
        verifier,
        d.req({
          kind: 'STAFF_ATTESTATION' as const,
          evidenceId: 'e',
          occurredAt: '2026-11-22T05:00:00Z',
          sourceRef: 'other_clinic_letter',
          reason: 'Confirmed by other clinic',
        }),
      );
      expect(r.workflowState).toBe('COMPLETED_VERIFIED');
      expect(r.bookingState).toBe('NONE');
    });

    it('reopen preserves history and returns a completion to evidence review', async () => {
      await d.create();
      await d.approve();
      now = new Date('2026-11-22T06:00:00Z');
      d.track(
        await svc.verifyCompletion(
          verifier,
          d.req({
            kind: 'STAFF_ATTESTATION' as const,
            evidenceId: 'e',
            occurredAt: '2026-11-22T05:00:00Z',
            sourceRef: 'x',
            reason: 'y',
          }),
        ),
      );
      await rejects(
        svc.reopenCase(coordinator, d.req({ reason: 'wrong patient' })),
        'ROLE_CANNOT_reopenCase',
      );
      const r = d.track(
        await svc.reopenCase(reviewer, d.req({ reason: 'Wrong patient on register' })),
      );
      expect(r.workflowState).toBe('AWAITING_EVIDENCE');
      const types = (await events()).map((e) => e.eventType);
      expect(types.slice(-2)).toEqual(['COMPLETION_VERIFIED', 'CASE_REOPENED']);
    });

    // ---- MVP-10 idempotency and concurrency ----------------------------------

    it('MVP-10: replaying the same request returns the same result with no second transition', async () => {
      await d.create();
      const req = d.req(
        { sourceAuthorityRef: 'order_1', checkedFields: [...ALL_CHECKS] },
        'approve-fixed',
      );
      const first = await svc.approve(reviewer, req);
      const again = await svc.approve(reviewer, req);
      expect(again).toEqual({ ...first, replayed: true });
      expect((await events()).length).toBe(2);
      // Same key, different payload is rejected.
      await rejects(
        svc.approve(reviewer, { ...req, input: { ...req.input, sourceAuthorityRef: 'other' } }),
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('MVP-10: a duplicated booking request creates one outbox item', async () => {
      await d.create();
      await d.approve();
      await d.dispatch();
      await d.patientBooks();
      const req = d.req({ slotId: 'slot_1', patientConfirmedSlot: true }, 'book-fixed');
      await svc.requestBooking(AGENT, req);
      await svc.requestBooking(AGENT, req);
      expect((await outbox()).filter((o) => o.kind === 'BOOKING_REQUEST')).toHaveLength(1);
    });

    it('concurrent commands on the same version: one wins, the other gets a version conflict', async () => {
      await d.create();
      await d.approve();
      const a = svc.dispatchContact(SYSTEM, d.req({ channel: 'BROWSER_VOICE' as const }));
      const c = svc.dispatchContact(SYSTEM, d.req({ channel: 'BROWSER_VOICE' as const }));
      const results = await Promise.allSettled([a, c]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((failed.reason as DomainError).code).toBe('VERSION_CONFLICT');
      expect((await getCase())?.contactAttempts).toBe(1);
      expect((await outbox()).filter((o) => o.kind === 'CONTACT_ATTEMPT')).toHaveLength(1);
    });

    it('a rejected command writes nothing (atomic)', async () => {
      await d.create();
      const before = await events();
      await rejects(d.dispatch(), 'INVALID_STATE_FOR_DISPATCH');
      expect(await events()).toEqual(before);
      expect((await getCase())?.version).toBe(1);
    });

    it('the auditor has no write commands', async () => {
      await rejects(
        svc.createCase(auditor, { idempotencyKey: 'a', input: newCase() }),
        'ROLE_CANNOT_createCase',
      );
      await d.create();
      await rejects(svc.cancelCase(auditor, d.req({ reason: 'x' })), 'ROLE_CANNOT_cancelCase');
    });
  });
}
