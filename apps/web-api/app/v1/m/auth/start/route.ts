import { loadConfig, type Patient, type Tenant } from '@careloop/contracts';
import { normalisePhone, startPhoneLogin, tenantDoc, tenantRecord } from '@careloop/domain';
import { newCorrelationId } from '@careloop/observability';
import { HttpError, toErrorResponse } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody } from '@/server/handler';
import { MobileStartBody } from '@/server/schemas';
import { jobRuntime } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * Step 1 of patient-app sign-in: send a code to this WhatsApp number. The
 * answer is the same whether or not the number belongs to a patient.
 *
 * Synthetic labs only, outside the pilot: when WhatsApp is not live for the
 * number, the code is returned as `simulatedCode` so the demo works without a
 * phone. Never for a real lab.
 */
export async function POST(req: Request) {
  const correlationId = newCorrelationId();
  try {
    const { phone } = MobileStartBody.parse(await jsonBody(req));
    const e164 = normalisePhone(phone);
    if (!e164)
      throw new HttpError('VALIDATION_FAILED', 'Enter a valid mobile number', { phone: 'invalid' });
    const db = firestore();
    const r = await startPhoneLogin(db, e164);
    const generic = { ok: true, channel: 'WHATSAPP', expiresInSeconds: 600 };
    if (!r.send) {
      if (r.reason === 'RATE_LIMITED')
        throw new HttpError('THROTTLED', 'Too many codes. Please wait 15 minutes.');
      return Response.json(generic, { headers: { 'cache-control': 'no-store' } });
    }
    const first = r.patients[0]!;
    const [patient, tenants] = await Promise.all([
      db.doc(tenantRecord(first.tenantId, 'patients', first.patientId)).get(),
      Promise.all(r.patients.map((p) => db.doc(tenantDoc(p.tenantId)).get())),
    ]);
    const sent = await jobRuntime().whatsapp.send({
      to: e164,
      template: 'LOGIN_CODE',
      language: (patient.data() as Patient | undefined)?.language ?? 'en-IN',
      params: [r.code],
    });
    const allSynthetic = tenants.every(
      (t) => (t.data() as Tenant | undefined)?.simulation === true,
    );
    const showCode = sent.status !== 'SENT' && allSynthetic && loadConfig().APP_ENV !== 'pilot';
    return Response.json(
      { ...generic, ...(showCode ? { simulatedCode: r.code, simulatedReason: sent.reason } : {}) },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return toErrorResponse(e, correlationId);
  }
}
