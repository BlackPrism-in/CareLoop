import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { tenantDoc, tenantRecord } from '@careloop/domain';
import { loadFixture } from './fixtures';

/**
 * Loads the synthetic demo tenant into the Firestore EMULATOR only.
 * Refuses to run against a real project.
 */
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    'Refusing to seed: FIRESTORE_EMULATOR_HOST is not set. Start `pnpm emulators` first.',
  );
  process.exit(1);
}

const bundle = loadFixture();
const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? 'demo-careloop';
if (!projectId.startsWith('demo-')) {
  console.error(`Refusing to seed project "${projectId}": only demo-* projects may be seeded.`);
  process.exit(1);
}

initializeApp({ projectId });
const db = getFirestore();
const t = bundle.tenant.tenantId;

const batch = db.batch();
batch.set(db.doc(tenantDoc(t)), bundle.tenant);
for (const s of bundle.sites) batch.set(db.doc(tenantRecord(t, 'sites', s.siteId)), s);
for (const m of bundle.members) batch.set(db.doc(tenantRecord(t, 'members', m.uid)), m);
for (const p of bundle.patients) batch.set(db.doc(tenantRecord(t, 'patients', p.patientId)), p);
for (const c of bundle.consents) batch.set(db.doc(tenantRecord(t, 'consents', c.consentId)), c);
for (const s of bundle.sources) batch.set(db.doc(tenantRecord(t, 'sources', s.sourceId)), s);
for (const c of bundle.cases) batch.set(db.doc(tenantRecord(t, 'cases', c.caseId)), c);
// Shift sandbox slots so the earliest is tomorrow, keeping their times of day.
const DAY = 86_400_000;
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

// Staff logins in the Auth EMULATOR. The tenant is a server-set custom claim;
// the API still checks the membership document on every request.
if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  const password = process.env.DEMO_STAFF_PASSWORD;
  if (!password || password.length < 8) {
    console.error('Set DEMO_STAFF_PASSWORD (see .env.example) to seed staff logins.');
    process.exit(1);
  }
  const auth = getAuth();
  for (const m of bundle.members) {
    try {
      await auth.updateUser(m.uid, { email: m.email, password, displayName: m.displayName });
    } catch {
      await auth.createUser({ uid: m.uid, email: m.email, password, displayName: m.displayName });
    }
    await auth.setCustomUserClaims(m.uid, { tenantId: t });
  }
  console.log(
    `Seeded ${bundle.members.length} staff logins in the Auth emulator (password from DEMO_STAFF_PASSWORD).`,
  );
} else {
  console.log('FIREBASE_AUTH_EMULATOR_HOST not set: skipped staff logins.');
}

console.log(
  `Seeded ${t}: ${bundle.members.length} members, ${bundle.patients.length} patients, ${bundle.cases.length} cases, ${bundle.slots.length} slots (synthetic).`,
);
