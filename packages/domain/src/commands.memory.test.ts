import { MemoryStore } from './memory-store';
import { commandSuite, type TestBackend } from './testing/suite';

commandSuite('memory store', () => {
  const store = new MemoryStore();
  const backend: TestBackend = {
    store,
    reset: async () => store.docs.clear(),
    seed: (path, data) => store.seed(path, data),
    read: async (path) => store.get(path),
    list: async <X>(collection: string) => store.list(`${collection}/`) as X[],
  };
  return backend;
});
