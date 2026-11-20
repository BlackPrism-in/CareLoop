import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@careloop/contracts', '@careloop/domain', '@careloop/observability'],
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  poweredByHeader: false,
};

export default config;
