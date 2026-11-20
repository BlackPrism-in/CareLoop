import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { seedBase } from './seed-lib';

/**
 * Loads the SYNTHETIC demo lab into a real demo/staging project, so a fresh
 * deployment has a lab, sites and staff who can sign in. Never for the pilot.
 *
 *   pnpm --filter @careloop/scripts bootstrap:staging --project <id> --confirm <id>
 *
 * - Uses your gcloud application-default credentials (no key files).
 * - Writes only the fixture lab (fictional patients, `.test` email addresses).
 * - Staff password: STAGING_STAFF_PASSWORD if set, else a random one. Either way
 *   it is written to `.env.staging.local` (git-ignored) and never printed.
 * - Safe to re-run: records are upserted, and the saved password is reused.
 */
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const projectId = arg('project');
const fail = (msg: string): never => {
  console.error(`Refusing: ${msg}`);
  process.exit(1);
};

if (!projectId) fail('pass --project <project-id>.');
if (arg('confirm') !== projectId) fail('pass --confirm with the same project ID to confirm.');
if (/pilot|prod/i.test(projectId!))
  fail(`"${projectId}" looks like a pilot or production project.`);
if (process.env.APP_ENV === 'pilot') fail('APP_ENV is pilot.');
// Talk to the real project, never to a local emulator by accident.
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
process.env.GOOGLE_CLOUD_PROJECT = projectId;

const SECRETS_FILE = fileURLToPath(new URL('../../.env.staging.local', import.meta.url));
function staffPassword(): string {
  if (process.env.STAGING_STAFF_PASSWORD) return process.env.STAGING_STAFF_PASSWORD;
  if (existsSync(SECRETS_FILE)) {
    const m = /^STAGING_STAFF_PASSWORD=(.+)$/m.exec(readFileSync(SECRETS_FILE, 'utf8'));
    if (m) return m[1]!.trim();
  }
  return `Cl-${randomBytes(12).toString('base64url')}`;
}

const app = getApps()[0] ?? initializeApp({ projectId });
const db = getFirestore(app);
const withCases = !process.argv.includes('--without-cases');
const bundle = await seedBase(db, { includeCases: withCases });

const password = staffPassword();
if (password.length < 12) fail('STAGING_STAFF_PASSWORD must be at least 12 characters.');
for (const m of bundle.members) {
  if (!m.email.endsWith('.test')) fail(`member ${m.uid} is not a synthetic .test address.`);
}
const auth = getAuth(app);
for (const m of bundle.members) {
  try {
    await auth.updateUser(m.uid, { email: m.email, password, displayName: m.displayName });
  } catch {
    await auth.createUser({ uid: m.uid, email: m.email, password, displayName: m.displayName });
  }
  await auth.setCustomUserClaims(m.uid, { tenantId: bundle.tenant.tenantId });
}

writeFileSync(
  SECRETS_FILE,
  [
    `# Synthetic staging staff logins for ${projectId}. Git-ignored; do not share in chat.`,
    `STAGING_PROJECT=${projectId}`,
    `STAGING_STAFF_EMAILS=${bundle.members.map((m) => m.email).join(',')}`,
    `STAGING_STAFF_PASSWORD=${password}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);

console.log(
  `Bootstrapped ${bundle.tenant.tenantId} in ${projectId}: ${bundle.sites.length} sites, ${bundle.members.length} staff logins, ${bundle.patients.length} synthetic patients, ${withCases ? bundle.cases.length : 0} cases.`,
);
console.log('Staff emails and the shared password are in .env.staging.local (not printed).');
