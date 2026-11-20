import type { Firestore, Query } from 'firebase-admin/firestore';
import type {
  Case,
  Consent,
  EventEnvelope,
  Member,
  Patient,
  Site,
  Source,
  WorkflowState,
} from '@careloop/contracts';
import { sourceIdFor } from './sources';
import { caseEvents, tenantCollection, tenantDoc, tenantRecord } from './paths';

/**
 * Read model for the staff UI. Every query is built from a tenantId that the
 * caller resolved from membership; there is no unscoped query in this module.
 * Lists use cursor pagination ordered by (dueAt, caseId) — no tenant scans.
 */

export interface CaseListFilter {
  workflowState?: WorkflowState;
  ownerId?: string;
  handoffPending?: boolean;
  /** Evidence awaiting a human: AWAITING_EVIDENCE or evidence under review/conflicted/self-reported. */
  needsProofReview?: boolean;
  limit?: number;
  cursor?: string;
}

export interface CaseListItem {
  caseId: string;
  patientAlias: string;
  actionType: Case['actionType'];
  workflowState: Case['workflowState'];
  outreachDisposition: Case['outreachDisposition'];
  handoffState: Case['handoffState'];
  evidenceState: Case['evidenceState'];
  bookingState: Case['bookingState'];
  automationPausedReason: Case['automationPausedReason'];
  dueAt: string;
  ownerId: string;
  ownerName: string;
  version: number;
}

const encodeCursor = (c: Pick<Case, 'dueAt' | 'caseId'>) =>
  Buffer.from(JSON.stringify([c.dueAt, c.caseId])).toString('base64url');
function decodeCursor(cursor: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'string')
      ? (v as [string, string])
      : null;
  } catch {
    return null;
  }
}

const PROOF_STATES: WorkflowState[] = ['AWAITING_EVIDENCE'];

export class CaseQueries {
  constructor(private readonly db: Firestore) {}

  private cases(tenantId: string) {
    return this.db.collection(tenantCollection(tenantId, 'cases'));
  }

  async getMember(tenantId: string, uid: string): Promise<Member | null> {
    const s = await this.db.doc(tenantRecord(tenantId, 'members', uid)).get();
    return s.exists ? (s.data() as Member) : null;
  }

  private async nameMaps(tenantId: string, cases: Case[]) {
    const patientIds = [...new Set(cases.map((c) => c.patientId))];
    const ownerIds = [...new Set(cases.map((c) => c.ownerId))];
    const refs = [
      ...patientIds.map((id) => this.db.doc(tenantRecord(tenantId, 'patients', id))),
      ...ownerIds.map((id) => this.db.doc(tenantRecord(tenantId, 'members', id))),
    ];
    const snaps = refs.length ? await this.db.getAll(...refs) : [];
    const patients = new Map<string, string>();
    const owners = new Map<string, string>();
    for (const s of snaps) {
      if (!s.exists) continue;
      const d = s.data()!;
      if (s.ref.parent.id === 'patients') patients.set(s.id, (d as Patient).alias);
      else owners.set(s.id, (d as Member).displayName);
    }
    return { patients, owners };
  }

  async listCases(
    tenantId: string,
    f: CaseListFilter = {},
  ): Promise<{ items: CaseListItem[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(f.limit ?? 25, 1), 100);
    let q: Query = this.cases(tenantId);
    if (f.workflowState) q = q.where('workflowState', '==', f.workflowState);
    if (f.ownerId) q = q.where('ownerId', '==', f.ownerId);
    if (f.handoffPending) q = q.where('handoffState', '==', 'PENDING');
    if (f.needsProofReview) q = q.where('workflowState', 'in', PROOF_STATES);
    q = q.orderBy('dueAt').orderBy('caseId');
    if (f.cursor) {
      const c = decodeCursor(f.cursor);
      if (c) q = q.startAfter(c[0], c[1]);
    }
    const snap = await q.limit(limit + 1).get();
    const rows = snap.docs.slice(0, limit).map((d) => d.data() as Case);
    const { patients, owners } = await this.nameMaps(tenantId, rows);
    const items = rows.map<CaseListItem>((c) => ({
      caseId: c.caseId,
      patientAlias: patients.get(c.patientId) ?? 'Unknown patient',
      actionType: c.actionType,
      workflowState: c.workflowState,
      outreachDisposition: c.outreachDisposition,
      handoffState: c.handoffState,
      evidenceState: c.evidenceState,
      bookingState: c.bookingState,
      automationPausedReason: c.automationPausedReason,
      dueAt: c.dueAt,
      ownerId: c.ownerId,
      ownerName: owners.get(c.ownerId) ?? c.ownerId,
      version: c.version,
    }));
    const last = rows[rows.length - 1];
    return { items, nextCursor: snap.docs.length > limit && last ? encodeCursor(last) : null };
  }

  /** Counts for the overview tiles. Uses aggregation queries, not document reads. */
  async overview(tenantId: string, uid: string) {
    const c = this.cases(tenantId);
    const count = async (q: Query) => (await q.count().get()).data().count;
    const [needApproval, handoffsPending, booked, proofToReview, mine] = await Promise.all([
      count(c.where('workflowState', '==', 'DRAFT')),
      count(c.where('handoffState', '==', 'PENDING')),
      count(c.where('workflowState', '==', 'BOOKED')),
      count(c.where('workflowState', 'in', PROOF_STATES)),
      count(c.where('ownerId', '==', uid)),
    ]);
    return { needApproval, handoffsPending, booked, proofToReview, mine };
  }

  async caseDetail(tenantId: string, caseId: string) {
    const snap = await this.db.doc(tenantRecord(tenantId, 'cases', caseId)).get();
    if (!snap.exists) return null;
    const c = snap.data() as Case;
    const [patient, consent, source, owner, site, eventsSnap] = await Promise.all([
      this.db.doc(tenantRecord(tenantId, 'patients', c.patientId)).get(),
      this.db.doc(tenantRecord(tenantId, 'consents', c.consentId)).get(),
      this.db.doc(tenantRecord(tenantId, 'sources', c.sourceId)).get(),
      this.db.doc(tenantRecord(tenantId, 'members', c.ownerId)).get(),
      this.db.doc(tenantRecord(tenantId, 'sites', c.siteId)).get(),
      this.db.collection(caseEvents(tenantId, caseId)).orderBy('nextVersion').limit(200).get(),
    ]);
    const p = patient.data() as Patient | undefined;
    const k = consent.data() as Consent | undefined;
    const events = eventsSnap.docs.map((d) => d.data() as EventEnvelope);
    const staffIds = [
      ...new Set(events.filter((e) => e.actorType === 'STAFF').map((e) => e.actorId)),
    ];
    const actorSnaps = staffIds.length
      ? await this.db.getAll(
          ...staffIds.map((u) => this.db.doc(tenantRecord(tenantId, 'members', u))),
        )
      : [];
    const actors: Record<string, string> = Object.fromEntries(
      actorSnaps.filter((s) => s.exists).map((s) => [s.id, (s.data() as Member).displayName]),
    );
    const now = Date.now();
    return {
      case: c,
      patient: p
        ? {
            alias: p.alias,
            contactMasked: p.contactMasked,
            language: p.language,
            ageEligibility: p.ageEligibility,
            externalRef: p.externalRef,
          }
        : null,
      consent: k
        ? {
            consentId: k.consentId,
            channels: k.channels,
            noticeVersion: k.noticeVersion,
            active: k.revokedAt === null && (k.expiresAt === null || Date.parse(k.expiresAt) > now),
            revokedAt: k.revokedAt,
          }
        : null,
      source: (source.data() as Source | undefined) ?? null,
      owner: owner.exists
        ? { uid: c.ownerId, displayName: (owner.data() as Member).displayName }
        : null,
      site: site.exists
        ? {
            siteId: c.siteId,
            displayName: (site.data() as Site).displayName,
            timeZone: (site.data() as Site).timeZone,
          }
        : null,
      events,
      /** Display names for staff who appear in the timeline. */
      actors,
    };
  }

  /** Pickers for the New follow-up form. Demo scale: bounded lists, aliases only. */
  async lookups(tenantId: string) {
    const [tenant, sites, members, patients, consents] = await Promise.all([
      this.db.doc(tenantDoc(tenantId)).get(),
      this.db.collection(tenantCollection(tenantId, 'sites')).limit(50).get(),
      this.db
        .collection(tenantCollection(tenantId, 'members'))
        .where('status', '==', 'ACTIVE')
        .limit(100)
        .get(),
      this.db.collection(tenantCollection(tenantId, 'patients')).limit(200).get(),
      this.db.collection(tenantCollection(tenantId, 'consents')).limit(400).get(),
    ]);
    const t = tenant.data();
    return {
      tenant: t
        ? { tenantId, displayName: t.displayName as string, simulation: t.simulation as boolean }
        : null,
      sites: sites.docs.map((d) => ({ siteId: d.id, displayName: (d.data() as Site).displayName })),
      members: members.docs.map((d) => {
        const m = d.data() as Member;
        return { uid: m.uid, displayName: m.displayName, roleSet: m.roleSet };
      }),
      patients: patients.docs.map((d) => {
        const p = d.data() as Patient;
        return {
          patientId: p.patientId,
          alias: p.alias,
          language: p.language,
          ageEligibility: p.ageEligibility,
        };
      }),
      consents: consents.docs
        .map((d) => d.data() as Consent)
        .filter((k) => k.revokedAt === null)
        .map((k) => ({ consentId: k.consentId, patientId: k.patientId, channels: k.channels })),
    };
  }

  /**
   * Registers the upstream instruction reference a case is created from.
   * Idempotent: the id is derived from authority + reference, so re-entering
   * the same order reuses the same source (and then hits duplicate detection).
   */
  async ensureSource(
    tenantId: string,
    s: { sourceAuthority: string; reference: string },
  ): Promise<string> {
    const sourceId = sourceIdFor(s);
    const ref = this.db.doc(tenantRecord(tenantId, 'sources', sourceId));
    await this.db.runTransaction(async (t) => {
      if ((await t.get(ref)).exists) return;
      const doc: Source = {
        sourceId,
        sourceAuthority: s.sourceAuthority.trim(),
        documentType: 'FORM',
        reference: s.reference.trim(),
      };
      t.create(ref, doc);
    });
    return sourceId;
  }
}
