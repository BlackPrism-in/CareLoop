import { randomUUID } from 'node:crypto';
import { loadConfig, type Patient } from '@careloop/contracts';
import { tenantRecord } from '@careloop/domain';
import { ingestProviderWebhook, signSandboxPayload } from '@careloop/jobs';
import { createLogger } from '@careloop/observability';
import { loadCase } from '@/server/case-helpers';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { SimulateEventBody } from '@/server/schemas';
import { jobRuntime, queries } from '@/server/services';

export const dynamic = 'force-dynamic';
const log = createLogger('careloop-web-api');

/**
 * Demo tool (synthetic labs only): emits a signed sandbox-calendar attendance
 * event through the real webhook path — signature, inbox, worker, matcher.
 * Every event is labelled simulation=true.
 */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  if (!session.ctx.roles.some((r) => r === 'COORDINATOR' || r === 'VERIFIER'))
    throw new HttpError('FORBIDDEN', 'Not permitted');
  const { scenario } = SimulateEventBody.parse(await jsonBody(req));
  const tenant = (await queries().lookups(session.ctx.tenantId)).tenant;
  if (!tenant?.simulation)
    throw new HttpError('FORBIDDEN', 'Simulation is only available in synthetic labs');
  const c = await loadCase(session.ctx.tenantId, params.id);
  const p = (
    await firestore()
      .doc(tenantRecord(session.ctx.tenantId, 'patients', c.patientId))
      .get()
  ).data() as Patient;
  const account = (
    await firestore()
      .collection('provider_accounts')
      .where('tenantId', '==', session.ctx.tenantId)
      .where('active', '==', true)
      .limit(1)
      .get()
  ).docs[0];
  const cfg = loadConfig();
  const accountName = account?.id.split('__')[1];
  const secret = accountName ? cfg.WEBHOOK_SIGNING_SECRETS[`sandbox:${accountName}`] : undefined;
  if (!accountName || !secret)
    throw new HttpError('DOMAIN_GUARD_FAILED', 'NO_SANDBOX_PROVIDER_ACCOUNT');
  const now = new Date();
  const event = {
    eventId: `sim_${randomUUID()}`,
    eventType: c.actionType === 'ORDERED_TEST' ? 'SAMPLE_COLLECTED' : 'APPOINTMENT_ATTENDED',
    sourceSystem: 'sandbox_calendar',
    externalBookingRef:
      scenario === 'WRONG_BOOKING' ? 'sbx_some_other_booking' : (c.bookingRef ?? undefined),
    patientExternalRef:
      scenario === 'WRONG_PATIENT' ? 'patient_ref_not_this_patient' : p.externalRef,
    occurredAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    receivedAt: now.toISOString(),
    simulation: true,
  };
  const raw = JSON.stringify(event);
  const result = await ingestProviderWebhook(
    {
      db: firestore(),
      secrets: cfg.WEBHOOK_SIGNING_SECRETS,
      dispatcher: jobRuntime().dispatcher,
      log,
    },
    {
      provider: 'sandbox',
      account: accountName,
      rawBody: raw,
      signature: signSandboxPayload(secret, Math.floor(now.getTime() / 1000), raw),
    },
  );
  return Response.json({ ...result, scenario, simulation: true }, { status: 202 });
});
