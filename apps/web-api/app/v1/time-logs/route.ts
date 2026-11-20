import type { Case } from '@careloop/contracts';
import { tenantCollection, tenantRecord } from '@careloop/domain';
import { loadCase } from '@/server/case-helpers';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { idempotencyKey, jsonBody, staffRoute } from '@/server/handler';
import { TimeLogBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';

export interface TimeLogDoc {
  logId: string;
  staffId: string;
  caseId: string | null;
  pilotArm: Case['pilotArm'];
  minutes: number;
  activity: string;
  note: string | null;
  at: string;
}

/**
 * Staff time per case (Blueprint p.11 workload measure: staff minutes per 100
 * cases, including review, handoffs and exceptions). Logged for every pilot
 * group, including baseline and usual care, so the comparison is fair.
 */
export const POST = staffRoute(async ({ req, session }) => {
  if (session.ctx.roles.every((r) => r === 'AUDITOR'))
    throw new HttpError('FORBIDDEN', 'Auditors do not log work');
  const key = idempotencyKey(req);
  const body = TimeLogBody.parse(await jsonBody(req));
  const db = firestore();
  const t = session.ctx.tenantId;
  let arm: Case['pilotArm'] = null;
  if (body.caseId) {
    const c = await loadCase(t, body.caseId, session.ctx.siteIds); // site scope
    arm = c.pilotArm;
  }
  const logId = `tl_${Buffer.from(`${session.ctx.actorId}:${key}`).toString('base64url').slice(0, 40)}`;
  const doc: TimeLogDoc = {
    logId,
    staffId: session.ctx.actorId,
    caseId: body.caseId ?? null,
    pilotArm: arm,
    minutes: body.minutes,
    activity: body.activity,
    note: body.note ?? null,
    at: new Date().toISOString(),
  };
  // Idempotent per key: a retried submit does not double-count minutes.
  await db.doc(tenantRecord(t, 'time_logs', logId)).set(doc);
  return Response.json(doc, { status: 201 });
});

export const GET = staffRoute(async ({ req, session }) => {
  const caseId = new URL(req.url).searchParams.get('caseId');
  let q = firestore().collection(tenantCollection(session.ctx.tenantId, 'time_logs')).limit(200);
  if (caseId) q = q.where('caseId', '==', caseId);
  const items = (await q.get()).docs
    .map((d) => d.data() as TimeLogDoc)
    .sort((a, b) => b.at.localeCompare(a.at));
  return Response.json({ items, totalMinutes: items.reduce((n, x) => n + x.minutes, 0) });
});
