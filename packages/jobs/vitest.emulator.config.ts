import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['src/**/*.emulator.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
