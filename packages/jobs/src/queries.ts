import type { Firestore } from 'firebase-admin/firestore';
import type { Patient } from '@careloop/contracts';
import { tenantCollection, tenantRecord, type OperationRecord } from '@careloop/domain';
import type { BookingDoc, BookingStatus, FailedJobDoc, JobDoc } from './types';

/** Tenant-scoped reads for bookings, operations and failed jobs. */
export class JobQueries {
  constructor(private readonly db: Firestore) {}

  async booking(tenantId: string, bookingId: string): Promise<BookingDoc | null> {
    const s = await this.db.doc(tenantRecord(tenantId, 'bookings', bookingId)).get();
    return s.exists ? (s.data() as BookingDoc) : null;
  }

  async bookingsForCase(tenantId: string, caseId: string): Promise<BookingDoc[]> {
    const snap = await this.db
      .collection(tenantCollection(tenantId, 'bookings'))
      .where('caseId', '==', caseId)
      .limit(20)
      .get();
    return snap.docs
      .map((d) => d.data() as BookingDoc)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listBookings(tenantId: string, statuses: BookingStatus[]) {
    const snap = await this.db
      .collection(tenantCollection(tenantId, 'bookings'))
      .where('status', 'in', statuses)
      .orderBy('updatedAt', 'desc')
      .limit(100)
      .get();
    const rows = snap.docs.map((d) => d.data() as BookingDoc);
    const caseRefs = [...new Set(rows.map((r) => r.caseId))].map((id) =>
      this.db.doc(tenantRecord(tenantId, 'cases', id)),
    );
    const cases = caseRefs.length ? await this.db.getAll(...caseRefs) : [];
    const patientIds = new Map(
      cases.filter((c) => c.exists).map((c) => [c.id, c.data()!.patientId as string]),
    );
    const pRefs = [...new Set(patientIds.values())].map((id) =>
      this.db.doc(tenantRecord(tenantId, 'patients', id)),
    );
    const patients = pRefs.length ? await this.db.getAll(...pRefs) : [];
    const alias = new Map(
      patients.filter((p) => p.exists).map((p) => [p.id, (p.data() as Patient).alias]),
    );
    return rows.map((r) => ({
      ...r,
      patientAlias: alias.get(patientIds.get(r.caseId) ?? '') ?? 'Unknown patient',
    }));
  }

  /** Operation status (GET /v1/operations/:id): the command result plus the jobs it scheduled. */
  async operation(tenantId: string, operationId: string) {
    const op = await this.db.doc(tenantRecord(tenantId, 'operations', operationId)).get();
    if (!op.exists) return null;
    const o = op.data() as OperationRecord;
    const jobs = await this.db.getAll(
      ...[0, 1, 2].map((i) => this.db.doc(tenantRecord(tenantId, 'jobs', `${operationId}-${i}`))),
    );
    return {
      operationId,
      command: o.command,
      caseId: o.caseId,
      result: o.result,
      createdAt: o.createdAt,
      jobs: jobs
        .filter((j) => j.exists)
        .map((j) => {
          const d = j.data() as JobDoc;
          return {
            jobId: d.jobId,
            kind: d.kind,
            status: d.status,
            attempts: d.attempts,
            result: d.result,
            error: d.error,
            updatedAt: d.updatedAt,
          };
        }),
    };
  }

  async failedJobs(tenantId: string): Promise<FailedJobDoc[]> {
    const snap = await this.db
      .collection(tenantCollection(tenantId, 'failed_jobs'))
      .orderBy('failedAt', 'desc')
      .limit(50)
      .get();
    return snap.docs.map((d) => d.data() as FailedJobDoc);
  }
}
