import type {
  PilotConfig,
  UsageMonth,
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
import type { EvidenceDoc, HandoffDoc } from './records';

export type PendingWrite = { path: string; data: object; mode: 'set' | 'create' | 'merge' };

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
  getEvidence = (id: string) => this.rec<EvidenceDoc>('evidence', id);
  getHandoff = (id: string) => this.rec<HandoffDoc>('handoffs', id);
  getUsage = (month: string) => this.rec<UsageMonth>('usage', month);
  getPilotConfig = () => this.rec<PilotConfig>('pilot', 'config');
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
  putEvidence(e: Partial<EvidenceDoc> & { evidenceId: string }, mode: 'create' | 'merge') {
    this.writes.push({
      path: tenantRecord(this.tenantId, 'evidence', e.evidenceId),
      data: e,
      mode,
    });
  }
  putHandoff(h: Partial<HandoffDoc> & { handoffId: string }, mode: 'create' | 'merge') {
    this.writes.push({ path: tenantRecord(this.tenantId, 'handoffs', h.handoffId), data: h, mode });
  }
  putUsage(u: UsageMonth) {
    this.writes.push({ path: tenantRecord(this.tenantId, 'usage', u.month), data: u, mode: 'set' });
  }
}
