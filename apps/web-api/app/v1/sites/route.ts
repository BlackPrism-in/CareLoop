import { randomUUID } from 'node:crypto';
import type { Site } from '@careloop/contracts';
import { tenantCollection, tenantRecord } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { SiteBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';

/** Sites the caller may see, with their contact hours. */
export const GET = staffRoute(async ({ session }) => {
  const snap = await firestore().collection(tenantCollection(session.ctx.tenantId, 'sites')).limit(100).get();
  const scope = session.ctx.siteIds;
  const items = snap.docs.map((d) => d.data() as Site).filter((s) => scope === undefined || scope === 'ALL' || scope.includes(s.siteId));
  return Response.json({ items });
});

/** Owner-only: add or update a site (multi-site labs). Audited. */
export const POST = staffRoute(async ({ req, session }) => {
  if (!session.ctx.roles.includes('OWNER')) throw new HttpError('FORBIDDEN', 'Only an owner can manage sites');
  const body = SiteBody.parse(await jsonBody(req));
  try {
    new Intl.DateTimeFormat('en', { timeZone: body.timeZone });
  } catch {
    throw new HttpError('VALIDATION_FAILED', 'Unknown time zone', { timeZone: 'invalid' });
  }
  const db = firestore();
  const now = new Date().toISOString();
  const auditId = randomUUID();
  const batch = db.batch();
  batch.set(db.doc(tenantRecord(session.ctx.tenantId, 'sites', body.siteId)), body satisfies Site);
  batch.set(db.doc(tenantRecord(session.ctx.tenantId, 'audit', auditId)), { auditId, action: 'SITE_SAVED', siteId: body.siteId, actorId: session.ctx.actorId, at: now });
  await batch.commit();
  return Response.json(body, { status: 201 });
});
