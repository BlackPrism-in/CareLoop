import { initializeApp } from 'firebase-admin/app';
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
for (const s of bundle.slots) batch.set(db.doc(tenantRecord(t, 'slots', s.slotId)), s);
await batch.commit();

console.log(
  `Seeded ${t}: ${bundle.members.length} members, ${bundle.patients.length} patients, ${bundle.cases.length} cases, ${bundle.slots.length} slots (synthetic).`,
);
