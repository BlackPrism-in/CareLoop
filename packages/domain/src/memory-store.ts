import type { Store, Tx } from './store';
import { BufferedTx } from './tx-base';

/**
 * In-memory Store for unit tests and local scenario replay. Transactions are
 * serialized, and writes commit only if the callback succeeds, so it has the
 * same all-or-nothing behavior the domain relies on in Firestore.
 */
export class MemoryStore implements Store {
  readonly docs = new Map<string, unknown>();
  private queue: Promise<unknown> = Promise.resolve();

  seed(path: string, data: object): void {
    this.docs.set(path, structuredClone(data));
  }

  get<X>(path: string): X | undefined {
    const v = this.docs.get(path);
    return v === undefined ? undefined : (structuredClone(v) as X);
  }

  list(prefix: string): unknown[] {
    return [...this.docs.entries()]
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => structuredClone(v));
  }

  runTransaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const run = async () => {
      const tx = new BufferedTx(tenantId, async (p) => this.get(p) ?? null);
      const out = await fn(tx);
      for (const w of tx.writes) {
        if (w.mode === 'create' && this.docs.has(w.path))
          throw new Error(`document already exists: ${w.path}`);
      }
      for (const w of tx.writes) this.docs.set(w.path, structuredClone(w.data));
      return out;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}
