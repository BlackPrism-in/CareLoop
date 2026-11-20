import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

const root = new URL('../../', import.meta.url).pathname;
// One env file for the whole repo: <root>/.env.local
loadEnvConfig(root);

const config: NextConfig = {
  output: 'standalone',
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    '@careloop/contracts',
    '@careloop/domain',
    '@careloop/observability',
    '@careloop/jobs',
    '@careloop/adapters',
  ],
  serverExternalPackages: ['firebase-admin', 'google-auth-library'],
  outputFileTracingRoot: root,
  poweredByHeader: false,
};

export default config;
