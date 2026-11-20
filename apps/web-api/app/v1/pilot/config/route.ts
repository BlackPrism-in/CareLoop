import { randomBytes, randomUUID } from 'node:crypto';
import type { PilotConfig } from '@careloop/contracts';
import { tenantRecord } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { PilotConfigBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';

const ORDER = ['NOT_STARTED', 'BASELINE', 'INTERVENTION', 'ENDED'] as const;

const visible = (c: PilotConfig) => {
  const { allocationSalt: _salt, ...rest } = c;
  return rest;
};

export const GET = staffRoute(async ({ session }) => {
  const c = (
    await firestore()
      .doc(tenantRecord(session.ctx.tenantId, 'pilot', 'config'))
      .get()
  ).data() as PilotConfig | undefined;
  return Response.json({ config: c ? visible(c) : null });
});

/**
 * Owner-only pilot setup (Blueprint p.11). The phase only moves forward
 * (not started → baseline → intervention → ended), so cohorts can't be
 * re-labelled after the fact. The allocation salt is created once and never
 * returned. Every change is audited.
 */
export const POST = staffRoute(async ({ req, session }) => {
  if (!session.ctx.roles.includes('OWNER'))
    throw new HttpError('FORBIDDEN', 'Only an owner can change the pilot');
  const body = PilotConfigBody.parse(await jsonBody(req));
  const db = firestore();
  const ref = db.doc(tenantRecord(session.ctx.tenantId, 'pilot', 'config'));
  const now = new Date().toISOString();
  const saved = await db.runTransaction(async (t) => {
    const cur = (await t.get(ref)).data() as PilotConfig | undefined;
    const from = ORDER.indexOf(cur?.phase ?? 'NOT_STARTED');
    const to = ORDER.indexOf(body.phase);
    if (to < from) throw new HttpError('DOMAIN_GUARD_FAILED', 'PILOT_PHASE_CANNOT_GO_BACK');
    if (
      cur?.phase === 'INTERVENTION' &&
      (body.interventionShare !== cur.interventionShare ||
        body.concurrentComparison !== cur.concurrentComparison)
    ) {
      throw new HttpError('DOMAIN_GUARD_FAILED', 'ALLOCATION_LOCKED_DURING_INTERVENTION');
    }
    const next: PilotConfig = {
      ...body,
      allocationSalt: cur?.allocationSalt ?? randomBytes(24).toString('base64url'),
      baselineStartedAt: cur?.baselineStartedAt ?? (to >= 1 ? now : null),
      interventionStartedAt: cur?.interventionStartedAt ?? (to >= 2 ? now : null),
      endedAt: cur?.endedAt ?? (to >= 3 ? now : null),
      updatedBy: session.ctx.actorId,
      updatedAt: now,
    };
    t.set(ref, next);
    const auditId = randomUUID();
    t.set(db.doc(tenantRecord(session.ctx.tenantId, 'audit', auditId)), {
      auditId,
      action: 'PILOT_CONFIG_CHANGED',
      from: cur?.phase ?? 'NOT_STARTED',
      to: body.phase,
      actorId: session.ctx.actorId,
      at: now,
    });
    return next;
  });
  return Response.json({ config: visible(saved) });
});
