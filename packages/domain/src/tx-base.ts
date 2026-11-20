import type {
  Case,
  Consent,
  EventEnvelope,
  Member,
  Patient,
  Site,
  Source,
  Tenant,
} from '@careloop/contracts';
import { caseEvents, tenantDoc, tenantRecord } from './paths';
import type { OperationRecord, OutboxRecord, Tx } from './store';

export type PendingWrite = { path: string; data: object; mode: 'set' | 'create' };

/**
 * Shared Tx logic over a path-based reader. Writes are buffered and returned
 * to the concrete store for an atomic commit; any read after a write throws,
 * mirroring Firestore's reads-before-writes rule so tests catch misuse.
 */
export class BufferedTx implements Tx {
  readonly writes: PendingWrite[] = [];

  constructor(
    private readonly tenantId: string,
    private readonly read: (path: string) => Promise<unknown | null>,
  ) {}

  private async get<X>(path: string): Promise<X | null> {
    if (this.writes.length > 0) throw new Error('transaction read after write');
    return (await this.read(path)) as X | null;
  }
  private rec<X>(collection: Parameters<typeof tenantRecord>[1], id: string) {
    return this.get<X>(tenantRecord(this.tenantId, collection, id));
  }

  getTenant = () => this.get<Tenant>(tenantDoc(this.tenantId));
  getSite = (id: string) => this.rec<Site>('sites', id);
  getMember = (id: string) => this.rec<Member>('members', id);
  getPatient = (id: string) => this.rec<Patient>('patients', id);
  getConsent = (id: string) => this.rec<Consent>('consents', id);
  getSource = (id: string) => this.rec<Source>('sources', id);
  getCase = (id: string) => this.rec<Case>('cases', id);
  getOperation = (id: string) => this.rec<OperationRecord>('operations', id);
  getCaseIdByFingerprint = async (fp: string) =>
    (await this.rec<{ caseId: string }>('case_fingerprints', fp))?.caseId ?? null;

  putCase(c: Case) {
    this.writes.push({
      path: tenantRecord(this.tenantId, 'cases', c.caseId),
      data: c,
      mode: 'set',
    });
  }
  createFingerprint(fp: string, caseId: string) {
    this.writes.push({
      path: tenantRecord(this.tenantId, 'case_fingerprints', fp),
      data: { caseId },
      mode: 'create',
    });
  }
  appendEvent(e: EventEnvelope) {
    this.writes.push({
      path: `${caseEvents(this.tenantId, e.caseId)}/${e.eventId}`,
      data: e,
      mode: 'create',
    });
  }
  enqueueOutbox(o: OutboxRecord) {
    this.writes.push({
      path: tenantRecord(this.tenantId, 'outbox', o.outboxId),
      data: o,
      mode: 'create',
    });
  }
  putOperation(o: OperationRecord) {
    this.writes.push({
      path: tenantRecord(this.tenantId, 'operations', o.operationId),
      data: o,
      mode: 'create',
    });
  }
}
