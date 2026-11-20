import type { Firestore } from 'firebase-admin/firestore';
import type { Case, Consent, EventEnvelope, Member, Patient, Slot } from '@careloop/contracts';
import { caseEvents, tenantCollection, type EvidenceDoc } from '@careloop/domain';
import { T1 } from '@careloop/domain/testing';

export interface InvariantResult {
  unauthorizedContact: string[];
  duplicateReservation: string[];
  falseCompletion: string[];
}

/**
 * The hard release gate (MVP spec §21), recomputed from stored data after
 * every scenario — independent of the scenario's own assertions:
 * - no contact attempt without a current approval and active permission;
 * - no more than one live reservation per case, no over-booked slot;
 * - no COMPLETED_VERIFIED without independent evidence (a matching signed
 *   provider event, or a staff record attested by a verifier).
 */
export async function checkInvariants(db: Firestore): Promise<InvariantResult> {
  const r: InvariantResult = {
    unauthorizedContact: [],
    duplicateReservation: [],
    falseCompletion: [],
  };
  const cases = (await db.collection(tenantCollection(T1, 'cases')).get()).docs.map(
    (d) => d.data() as Case,
  );
  const consents = new Map(
    (await db.collection(tenantCollection(T1, 'consents')).get()).docs.map((d) => [
      d.id,
      d.data() as Consent,
    ]),
  );
  const patients = new Map(
    (await db.collection(tenantCollection(T1, 'patients')).get()).docs.map((d) => [
      d.id,
      d.data() as Patient,
    ]),
  );
  const verifiers = new Set(
    (await db.collection(tenantCollection(T1, 'members')).get()).docs
      .map((d) => d.data() as Member)
      .filter((m) => m.roleSet.includes('VERIFIER'))
      .map((m) => m.uid),
  );

  for (const c of cases) {
    const events = (await db.collection(caseEvents(T1, c.caseId)).get()).docs
      .map((d) => d.data() as EventEnvelope)
      .sort((a, b) => (a.nextVersion ?? 0) - (b.nextVersion ?? 0));
    let approved = false;
    let suppressed = false;
    for (const e of events) {
      if (e.eventType === 'CASE_APPROVED') approved = true;
      if (
        e.eventType === 'CASE_EDITED_APPROVAL_INVALIDATED' ||
        (e.eventType === 'CASE_REOPENED' && e.payload.from === 'CANCELLED')
      )
        approved = false;
      if (e.eventType === 'PATIENT_OPTED_OUT') suppressed = true;
      if (e.eventType === 'CONTACT_DISPATCHED') {
        const k = consents.get(c.consentId);
        const revokedBefore = k?.revokedAt && Date.parse(k.revokedAt) < Date.parse(e.occurredAt);
        if (!approved || suppressed || revokedBefore)
          r.unauthorizedContact.push(`${c.caseId} v${e.nextVersion}`);
      }
    }

    if (c.workflowState === 'COMPLETED_VERIFIED') {
      const ev = (
        await db.collection(tenantCollection(T1, 'evidence')).where('caseId', '==', c.caseId).get()
      ).docs.map((d) => d.data() as EvidenceDoc);
      const ref = patients.get(c.patientId)?.externalRef;
      const independent = ev.some(
        (x) =>
          x.status === 'VERIFIED' &&
          ((x.kind === 'PROVIDER_EVENT' && x.patientRef === ref) ||
            (x.kind === 'STAFF_RECORD' && x.decidedBy !== null && verifiers.has(x.decidedBy))),
      );
      const selfVerified = ev.some((x) => x.kind === 'SELF_REPORT' && x.status === 'VERIFIED');
      // Attestation without a separate evidence record (domain-level command) is also acceptable if a verifier did it.
      const attestedEvent = events.some(
        (e) =>
          e.eventType === 'COMPLETION_VERIFIED' &&
          e.payload.kind === 'STAFF_ATTESTATION' &&
          verifiers.has(String(e.payload.verifierId)),
      );
      if ((!independent && !attestedEvent) || selfVerified) r.falseCompletion.push(c.caseId);
    }
  }

  const reservations = (
    await db.collection(tenantCollection(T1, 'sandbox_reservations')).get()
  ).docs.map((d) => d.data() as { caseId: string; slotId: string; status: string });
  const live = reservations.filter((x) => x.status === 'RESERVED');
  const perCase = new Map<string, number>();
  for (const x of live) perCase.set(x.caseId, (perCase.get(x.caseId) ?? 0) + 1);
  for (const [caseId, n] of perCase)
    if (n > 1) r.duplicateReservation.push(`${caseId}: ${n} live reservations`);
  const slots = (await db.collection(tenantCollection(T1, 'slots')).get()).docs.map(
    (d) => d.data() as Slot,
  );
  for (const s of slots) {
    const n = live.filter((x) => x.slotId === s.slotId).length;
    if (s.reserved > s.capacity || n > s.capacity)
      r.duplicateReservation.push(`${s.slotId}: ${n}/${s.capacity}`);
  }
  return r;
}

export const invariantsHold = (r: InvariantResult) =>
  r.unauthorizedContact.length === 0 &&
  r.duplicateReservation.length === 0 &&
  r.falseCompletion.length === 0;
