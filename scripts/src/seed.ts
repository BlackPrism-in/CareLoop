import { emulatorOnly, seedBase, seedLogins } from './seed-lib';

/** Loads the synthetic demo lab (with its DRAFT cases) into the emulators only. */
const { db } = emulatorOnly();
const bundle = await seedBase(db, { includeCases: true });
const logins = await seedLogins(bundle);
console.log(
  logins
    ? `Seeded ${bundle.members.length} staff logins in the Auth emulator (password from DEMO_STAFF_PASSWORD).`
    : 'FIREBASE_AUTH_EMULATOR_HOST not set: skipped staff logins.',
);
console.log(
  `Seeded ${bundle.tenant.tenantId}: ${bundle.members.length} members, ${bundle.patients.length} patients, ${bundle.cases.length} cases, ${bundle.slots.length} slots (synthetic).`,
);
