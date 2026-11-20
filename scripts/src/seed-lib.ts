import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { tenantDoc, tenantRecord } from '@careloop/domain';
import type { FixtureBundle } from '@careloop/contracts';
import { loadFixture } from './fixtures';

/** Emulator-only guard: never seed or wipe a real project. */
export function emulatorOnly(): { projectId: string; db: Firestore } {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.error('Refusing: FIRESTORE_EMULATOR_HOST is not set. Start `pnpm emulators` first.');
    process.exit(1);
  }
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'demo-careloop';
  if (!projectId.startsWith('demo-')) {
    console.error(`Refusing to touch project "${projectId}": only demo-* projects are allowed.`);
    process.exit(1);
  }
  const app = getApps()[0] ?? initializeApp({ projectId });
  return { projectId, db: getFirestore(app) };
}

const DAY = 86_400_000;

/** Writes the synthetic lab. Sandbox slots are shifted so the earliest is tomorrow. */
export async function seedBase(
  db: Firestore,
  opts: { includeCases: boolean },
): Promise<FixtureBundle> {
  const bundle = loadFixture();
  const t = bundle.tenant.tenantId;
  const batch = db.batch();
  batch.set(db.doc(tenantDoc(t)), bundle.tenant);
  for (const s of bundle.sites) batch.set(db.doc(tenantRecord(t, 'sites', s.siteId)), s);
  for (const m of bundle.members) batch.set(db.doc(tenantRecord(t, 'members', m.uid)), m);
  for (const p of bundle.patients) batch.set(db.doc(tenantRecord(t, 'patients', p.patientId)), p);
  for (const c of bundle.consents) batch.set(db.doc(tenantRecord(t, 'consents', c.consentId)), c);
  for (const s of bundle.sources) batch.set(db.doc(tenantRecord(t, 'sources', s.sourceId)), s);
  if (opts.includeCases)
    for (const c of bundle.cases) batch.set(db.doc(tenantRecord(t, 'cases', c.caseId)), c);
  const earliest = Math.min(...bundle.slots.map((s) => Date.parse(s.startsAt)));
  const shift = (Math.floor(Date.now() / DAY) + 1 - Math.floor(earliest / DAY)) * DAY;
  for (const s of bundle.slots) {
    batch.set(db.doc(tenantRecord(t, 'slots', s.slotId)), {
      ...s,
      startsAt: new Date(Date.parse(s.startsAt) + shift).toISOString(),
      endsAt: new Date(Date.parse(s.endsAt) + shift).toISOString(),
    });
  }
  // Sandbox calendar account → this tenant (webhook tenant mapping is server-side, never from payloads).
  batch.set(db.doc('provider_accounts/sandbox__demo-calendar'), { tenantId: t, active: true });
  await batch.commit();
  return bundle;
}

/** Staff logins in the Auth EMULATOR. The tenant is a server-set claim; membership is still checked per request. */
export async function seedLogins(bundle: FixtureBundle): Promise<boolean> {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) return false;
  const password = process.env.DEMO_STAFF_PASSWORD;
  if (!password || password.length < 8)
    throw new Error('Set DEMO_STAFF_PASSWORD (see .env.example) to seed staff logins.');
  const auth = getAuth();
  for (const m of bundle.members) {
    try {
      await auth.updateUser(m.uid, { email: m.email, password, displayName: m.displayName });
    } catch {
      await auth.createUser({ uid: m.uid, email: m.email, password, displayName: m.displayName });
    }
    await auth.setCustomUserClaims(m.uid, { tenantId: bundle.tenant.tenantId });
  }
  return true;
}
