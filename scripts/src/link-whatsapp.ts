import type { Consent, Tenant } from '@careloop/contracts';
import {
  normalisePhone,
  setPatientWhatsApp,
  tenantCollection,
  tenantDoc,
  tenantRecord,
} from '@careloop/domain';
import { demoTarget } from './seed-lib';

/**
 * Links a TESTER'S OWN WhatsApp number to a synthetic patient, so the patient
 * app sign-in and WhatsApp messages can be tried end to end. Refuses any lab
 * that is not a simulation lab. Also records WhatsApp in that synthetic
 * patient's consents (a real lab records this from the patient's own consent).
 *
 *   pnpm --filter @careloop/scripts link-whatsapp --patient pat_demo_01 --phone +9198XXXXXXXX \
 *     [--project <id> --confirm <id>]
 *
 * For messages to really arrive outside the pilot, the number must also be in
 * WHATSAPP_TEST_RECIPIENTS.
 */
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const { projectId, db } = demoTarget();
const tenantId = arg('tenant') ?? 't_demo_siliguri';
const patientId = arg('patient');
const phone = normalisePhone(arg('phone') ?? '');
if (!patientId || !phone) {
  console.error('Usage: --patient <patientId> --phone <+91XXXXXXXXXX>');
  process.exit(2);
}
const tenant = (await db.doc(tenantDoc(tenantId)).get()).data() as Tenant | undefined;
if (!tenant?.simulation) {
  console.error(`Refusing: ${tenantId} is not a synthetic (simulation) lab.`);
  process.exit(1);
}
if (!(await db.doc(tenantRecord(tenantId, 'patients', patientId)).get()).exists) {
  console.error(`No patient ${patientId} in ${tenantId}.`);
  process.exit(1);
}
await setPatientWhatsApp(db, { tenantId, patientId }, phone, 'script:link-whatsapp');
const consents = await db
  .collection(tenantCollection(tenantId, 'consents'))
  .where('patientId', '==', patientId)
  .get();
for (const d of consents.docs) {
  const k = d.data() as Consent;
  if (!k.revokedAt && !k.channels.includes('WHATSAPP'))
    await d.ref.update({ channels: [...k.channels, 'WHATSAPP'], version: k.version + 1 });
}
console.log(
  `Linked ${phone.slice(0, 3)} •••••• ${phone.slice(-4)} to ${patientId} in ${tenantId} (${projectId}); WhatsApp added to ${consents.size} consent(s).`,
);
process.exit(0);
