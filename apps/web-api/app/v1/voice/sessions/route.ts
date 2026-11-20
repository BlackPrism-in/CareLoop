import { randomUUID } from 'node:crypto';
import { loadConfig, type PilotConfig } from '@careloop/contracts';
import { CONVERSATION_PROMPT } from '@careloop/ai';
import { issueVoiceTicket, tenantCollection, tenantRecord } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { VoiceSessionBody } from '@/server/schemas';
import { queries } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * Issues a short-lived, single-use, case-bound voice session ticket (MVP spec
 * §11). No model key and no health data are returned. In a real lab this
 * channel stays closed until outreach is enabled for the pilot.
 */
export const POST = staffRoute(async ({ req, session }) => {
  if (!session.ctx.roles.includes('COORDINATOR'))
    throw new HttpError('FORBIDDEN', 'Only coordinators can start calls');
  const { caseId } = VoiceSessionBody.parse(await jsonBody(req));
  const cfg = loadConfig();
  const detail = await queries().caseDetail(session.ctx.tenantId, caseId, session.ctx.siteIds);
  if (!detail) throw new HttpError('NOT_FOUND', 'Case not found');
  const c = detail.case;
  const tenant = (await queries().lookups(session.ctx.tenantId, session.ctx.siteIds)).tenant;
  if (!tenant?.simulation && !cfg.OUTREACH_ENABLED)
    throw new HttpError('DOMAIN_GUARD_FAILED', 'OUTREACH_DISABLED');
  if (c.workflowState !== 'CONTACTING' && c.workflowState !== 'AWAITING_BOOKING')
    throw new HttpError('DOMAIN_GUARD_FAILED', 'CASE_NOT_IN_CONTACT');
  if (['OPTED_OUT', 'DECLINED'].includes(c.outreachDisposition))
    throw new HttpError('DOMAIN_GUARD_FAILED', 'PATIENT_SUPPRESSED');
  if (c.audioSecondsUsed >= cfg.MAX_CASE_AUDIO_SECONDS - 10)
    throw new HttpError('DOMAIN_GUARD_FAILED', 'AUDIO_BUDGET_EXHAUSTED');

  const interactionId = `int_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  // Pilot protocol: the first N calls of the intervention period need a supervised review.
  const pilot = (
    await firestore()
      .doc(tenantRecord(session.ctx.tenantId, 'pilot', 'config'))
      .get()
  ).data() as PilotConfig | undefined;
  let reviewStatus: 'PENDING' | 'NOT_REQUIRED' = 'NOT_REQUIRED';
  if (pilot?.phase === 'INTERVENTION') {
    const already = (
      await firestore()
        .collection(tenantCollection(session.ctx.tenantId, 'interactions'))
        .where('reviewStatus', 'in', ['PENDING', 'REVIEWED'])
        .count()
        .get()
    ).data().count;
    if (already < pilot.supervisedReviewFirstN) reviewStatus = 'PENDING';
  }
  await firestore()
    .doc(tenantRecord(session.ctx.tenantId, 'interactions', interactionId))
    .create({
      interactionId,
      caseId,
      channel: 'BROWSER_VOICE',
      providerId: 'gemini-live',
      status: 'CREATED',
      createdBy: session.ctx.actorId,
      createdAt: new Date().toISOString(),
      model: cfg.LIVE_MODEL_ID,
      promptVersion: CONVERSATION_PROMPT.version,
      simulation: tenant?.simulation ?? false,
      reviewStatus,
      pilotArm: c.pilotArm,
    });
  const { ticket, expiresAt } = await issueVoiceTicket(firestore(), {
    tenantId: session.ctx.tenantId,
    caseId,
    interactionId,
    createdBy: session.ctx.actorId,
  });
  return Response.json(
    {
      ticket,
      expiresAt,
      interactionId,
      wsUrl: `${cfg.VOICE_PUBLIC_URL}/v1/voice/connect`,
      simulation: tenant?.simulation ?? false,
    },
    { status: 201 },
  );
});
