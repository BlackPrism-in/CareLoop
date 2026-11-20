import type { Firestore } from 'firebase-admin/firestore';
import type { Store, Tx } from './store';
import { BufferedTx } from './tx-base';

/**
 * Firestore-backed Store. The callback may be retried by Firestore on
 * contention, which is safe because it performs no external side effects;
 * provider calls happen later from the outbox. Server SDKs bypass Security
 * Rules, so tenant scoping lives in the path helpers used by BufferedTx.
 */
export class FirestoreStore implements Store {
  constructor(private readonly db: Firestore) {}

  runTransaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async (t) => {
      const tx = new BufferedTx(tenantId, async (path) => {
        const snap = await t.get(this.db.doc(path));
        return snap.exists ? (snap.data() ?? null) : null;
      });
      const out = await fn(tx);
      for (const w of tx.writes) {
        const ref = this.db.doc(w.path);
        if (w.mode === 'create') t.create(ref, w.data);
        else t.set(ref, w.data);
      }
      return out;
    });
  }
}
