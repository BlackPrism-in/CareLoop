import { loadConfig } from '@careloop/contracts';
import { createGenAIClient, GenAiJsonModel, reviewEvidence } from '@careloop/ai';
import { sha256, tenantCollection, tenantRecord, type EvidenceDoc } from '@careloop/domain';
import type { Patient } from '@careloop/contracts';
import { loadCase } from '@/server/case-helpers';
import { firestore } from '@/server/firebase';
import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { RecordEvidenceBody } from '@/server/schemas';
import { caseCommands, kick, queries } from '@/server/services';

export const dynamic = 'force-dynamic';

export const GET = staffRoute<{ id: string }>(async ({ session, params }) => {
  await loadCase(session.ctx.tenantId, params.id, session.ctx.siteIds);
  const snap = await firestore()
    .collection(tenantCollection(session.ctx.tenantId, 'evidence'))
    .where('caseId', '==', params.id)
    .orderBy('receivedAt', 'desc')
    .limit(50)
    .get();
  return Response.json({ items: snap.docs.map((d) => d.data() as EvidenceDoc) });
});

/**
 * Staff record an evidence candidate (MVP spec §18). A staff record never
 * completes a case by itself: it waits for a verifier's attestation. A
 * self-report is kept separate and excluded from verified completion.
 */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  const key = idempotencyKey(req);
  const body = RecordEvidenceBody.parse(await jsonBody(req));
  const c = await loadCase(session.ctx.tenantId, params.id, session.ctx.siteIds);
  const tenant = (await queries().lookups(session.ctx.tenantId, session.ctx.siteIds)).tenant;
  let aiReview: Record<string, unknown> | null = null;
  if (body.kind === 'STAFF_RECORD' && body.excerpt) {
    // Optional verification agent: a recommendation shown to the verifier, never a decision.
    try {
      const cfg = loadConfig();
      const p = (
        await firestore()
          .doc(tenantRecord(session.ctx.tenantId, 'patients', c.patientId))
          .get()
      ).data() as Patient | undefined;
      const r = await reviewEvidence(
        new GenAiJsonModel(createGenAIClient(cfg)),
        cfg.VERIFICATION_MODEL_ID,
        {
          excerpt: body.excerpt,
          caseRefs: {
            patientRef: p?.externalRef ?? null,
            actionType: c.actionType,
            occurredAt: body.occurredAt,
            provider: body.issuer,
            bookingRef: c.bookingRef,
          },
        },
      );
      aiReview = { ...r };
    } catch {
      aiReview = { unavailable: true };
    }
  }
  const result = await caseCommands().recordEvidence(session.ctx, {
    caseId: c.caseId,
    expectedVersion: body.expectedVersion,
    idempotencyKey: key,
    input: {
      evidenceId: `ev_${sha256(`${session.ctx.actorId}:${key}`).slice(0, 24)}`,
      kind: body.kind,
      issuer: body.issuer,
      eventType: body.eventType,
      patientRef: body.patientRef || null,
      bookingRef: body.bookingRef || null,
      occurredAt: body.occurredAt,
      sourceRef: body.sourceRef,
      simulation: tenant?.simulation ?? false,
      excerpt: body.excerpt ?? null,
      aiReview,
    },
  });
  await kick(session.ctx.tenantId, c.caseId);
  return Response.json(result, { status: 201 });
});
