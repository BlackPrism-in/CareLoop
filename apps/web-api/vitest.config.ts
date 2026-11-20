import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/.next/**', '**/*.emulator.test.ts'],
    env: {
      INTAKE_MODEL_ID: 't',
      COORDINATION_MODEL_ID: 't',
      VERIFICATION_MODEL_ID: 't',
      LIVE_MODEL_ID: 't',
    },
  },
});
