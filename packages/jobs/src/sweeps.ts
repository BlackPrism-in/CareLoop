import type { Firestore } from 'firebase-admin/firestore';
import type { Case, Member, Site } from '@careloop/contracts';
import {
  DomainError,
  tenantCollection,
  tenantRecord,
  withinContactWindow,
  type CaseCommands,
  type HandoffDoc,
} from '@careloop/domain';
import type { Logger } from '@careloop/observability';

export interface NotificationDoc {
  notificationId: string;
  recipientId: string;
  kind: 'HANDOFF_ASSIGNED' | 'HANDOFF_OVERDUE';
  caseId: string;
  handoffId: string;
  createdAt: string;
  readAt: string | null;
}

/**
 * Time-based work run by the scheduler (every minute in the cloud):
 * - BOOKED cases whose appointment has passed move to AWAITING_EVIDENCE (never completed).
 * - Unacknowledged handoffs past their operational deadline notify backup staff
 *   once, during the site's staffed hours. This is not emergency coverage.
 */
export class TimeSweeps {
  private readonly clock: () => Date;
  constructor(
    private readonly db: Firestore,
    private readonly commands: CaseCommands,
    private readonly log: Logger,
    opts: { clock?: () => Date } = {},
  ) {
    this.clock = opts.clock ?? (() => new Date());
  }

  async run(): Promise<{
    awaitingEvidence: number;
    backupNotified: number;
    retentionDeleted: number;
  }> {
    return {
      awaitingEvidence: await this.occurrencesPassed(),
      backupNotified: await this.overdueHandoffs(),
      retentionDeleted: await this.retention(),
    };
  }

  private async occurrencesPassed(): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - 30 * 60_000).toISOString();
    const snap = await this.db
      .collectionGroup('cases')
      .where('workflowState', '==', 'BOOKED')
      .where('bookedStartsAt', '<', cutoff)
      .limit(100)
      .get();
    let n = 0;
    for (const d of snap.docs) {
      const c = d.data() as Case;
      const tenantId = d.ref.parent.parent!.id;
      try {
        await this.commands.awaitEvidence(
          {
            tenantId,
            actorType: 'SYSTEM',
            actorId: 'scheduler',
            roles: [],
            correlationId: `sweep-${c.caseId}`,
          },
          {
            caseId: c.caseId,
            expectedVersion: c.version,
            idempotencyKey: `sweep:await-evidence:${c.caseId}:${c.version}`,
            input: { trigger: 'OCCURRENCE_PASSED' },
          },
        );
        n++;
      } catch (e) {
        if (!(e instanceof DomainError)) throw e; // a concurrent change wins; next sweep re-checks
      }
    }
    return n;
  }

  private async overdueHandoffs(): Promise<number> {
    const now = this.clock();
    const snap = await this.db
      .collectionGroup('handoffs')
      .where('status', '==', 'PENDING')
      .where('backupNotifiedAt', '==', null)
      .where('dueAt', '<', now.toISOString())
      .limit(100)
      .get();
    let n = 0;
    for (const d of snap.docs) {
      const h = d.data() as HandoffDoc;
      const tenantId = d.ref.parent.parent!.id;
      const c = (await this.db.doc(tenantRecord(tenantId, 'cases', h.caseId)).get()).data() as
        Case | undefined;
      const site = c
        ? ((await this.db.doc(tenantRecord(tenantId, 'sites', c.siteId)).get()).data() as
            Site | undefined)
        : undefined;
      if (!site || !withinContactWindow(now, site.contactWindow, site.timeZone)) continue; // staffed hours only
      const members = (
        await this.db
          .collection(tenantCollection(tenantId, 'members'))
          .where('status', '==', 'ACTIVE')
          .get()
      ).docs.map((m) => m.data() as Member);
      const backups = members.filter(
        (m) => m.uid !== h.ownerId && m.roleSet.some((r) => r === 'OWNER' || r === 'REVIEWER'),
      );
      const marked = await this.db.runTransaction(async (t) => {
        const cur = (await t.get(d.ref)).data() as HandoffDoc;
        if (cur.status !== 'PENDING' || cur.backupNotifiedAt) return false;
        t.update(d.ref, { backupNotifiedAt: now.toISOString() });
        for (const m of backups) {
          const id = `${h.handoffId}-overdue-${m.uid}`;
          const doc: NotificationDoc = {
            notificationId: id,
            recipientId: m.uid,
            kind: 'HANDOFF_OVERDUE',
            caseId: h.caseId,
            handoffId: h.handoffId,
            createdAt: now.toISOString(),
            readAt: null,
          };
          t.set(this.db.doc(tenantRecord(tenantId, 'notifications', id)), doc);
        }
        return true;
      });
      if (marked) {
        n++;
        this.log.info('overdue handoff escalated to backup', {
          tenantId,
          handoffId: h.handoffId,
          backups: backups.length,
        });
      }
    }
    return n;
  }

  /**
   * Retention defaults (MVP spec §19, a proposal for customer review). Deletes
   * short-lived credentials once expired and operational records after 30
   * days. Case, evidence, approval and audit records are kept under the
   * customer's retention schedule and are not touched here. Bounded per run.
   */
  async retention(limit = 200): Promise<number> {
    const now = this.clock();
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const targets = [
      this.db.collection('voice_tickets').where('expiresAt', '<', ago(1)),
      this.db.collection('patient_sessions').where('expiresAt', '<', ago(1)),
      this.db.collection('patient_links').where('expiresAt', '<', ago(30)),
      this.db.collectionGroup('inbox').where('receivedAt', '<', ago(30)),
      this.db.collectionGroup('notifications').where('createdAt', '<', ago(30)),
      this.db
        .collectionGroup('outbox')
        .where('status', 'in', ['DONE', 'SKIPPED'])
        .where('createdAt', '<', ago(30)),
      this.db
        .collectionGroup('jobs')
        .where('status', 'in', ['DONE', 'SKIPPED'])
        .where('updatedAt', '<', ago(30)),
      this.db.collectionGroup('operations').where('createdAt', '<', ago(30)),
    ];
    let deleted = 0;
    for (const q of targets) {
      const snap = await q.limit(limit).get();
      if (snap.empty) continue;
      const batch = this.db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
    }
    if (deleted) this.log.info('retention sweep', { deleted });
    return deleted;
  }
}
