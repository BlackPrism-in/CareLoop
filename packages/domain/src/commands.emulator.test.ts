import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { FirestoreStore } from './firestore-store';
import { commandSuite, type TestBackend } from './testing/suite';

/**
 * Runs the full command suite against the Firestore emulator. Started by
 * `pnpm test:emulator`, which wraps vitest in `firebase emulators:exec`.
 */
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) throw new Error('FIRESTORE_EMULATOR_HOST is required (run `pnpm test:emulator`)');
const projectId = 'demo-careloop-test';

const app = getApps()[0] ?? initializeApp({ projectId });
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: false });

commandSuite('firestore emulator', () => {
  const backend: TestBackend = {
    store: new FirestoreStore(db),
    reset: async () => {
      const res = await fetch(
        `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`emulator reset failed: ${res.status}`);
    },
    seed: (path, data) => db.doc(path).set(data),
    read: async <X>(path: string) => {
      const snap = await db.doc(path).get();
      return snap.exists ? (snap.data() as X) : undefined;
    },
    list: async <X>(collection: string) =>
      (await db.collection(collection).get()).docs.map((d) => d.data() as X),
  };
  return backend;
});
