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
    fileParallelism: false,
    include: ['test/**/*.emulator.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    env: {
      GOOGLE_CLOUD_PROJECT: 'demo-careloop-api',
      INTAKE_MODEL_ID: 'test-intake',
      COORDINATION_MODEL_ID: 'test-coord',
      VERIFICATION_MODEL_ID: 'test-verify',
      LIVE_MODEL_ID: 'test-live',
      WEBHOOK_SIGNING_SECRETS: '{"sandbox:demo-calendar":"api-test-webhook-secret-01"}',
    },
  },
});
