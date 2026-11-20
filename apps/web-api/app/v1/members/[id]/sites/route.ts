import { randomUUID } from 'node:crypto';
import type { Member } from '@careloop/contracts';
import { tenantCollection, tenantRecord } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { MemberSitesBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';

/** Owner-only: which sites a staff member works at. Takes effect on their next request. Audited. */
export const POST = staffRoute<{ id: string }>(async ({ req, session, params }) => {
  if (!session.ctx.roles.includes('OWNER'))
    throw new HttpError('FORBIDDEN', 'Only an owner can assign sites');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.id))
    throw new HttpError('NOT_FOUND', 'Member not found');
  const { permittedSiteIds } = MemberSitesBody.parse(await jsonBody(req));
  const db = firestore();
  const t = session.ctx.tenantId;
  const ref = db.doc(tenantRecord(t, 'members', params.id));
  const m = (await ref.get()).data() as Member | undefined;
  if (!m) throw new HttpError('NOT_FOUND', 'Member not found');
  const sites = new Set(
    (await db.collection(tenantCollection(t, 'sites')).get()).docs.map((d) => d.id),
  );
  const unknown = permittedSiteIds.filter((s) => !sites.has(s));
  if (unknown.length)
    throw new HttpError('VALIDATION_FAILED', 'Unknown site', {
      permittedSiteIds: unknown.join(','),
    });
  const now = new Date().toISOString();
  const auditId = randomUUID();
  const batch = db.batch();
  batch.update(ref, { permittedSiteIds });
  batch.set(db.doc(tenantRecord(t, 'audit', auditId)), {
    auditId,
    action: 'MEMBER_SITES_CHANGED',
    memberId: m.uid,
    from: m.permittedSiteIds,
    to: permittedSiteIds,
    actorId: session.ctx.actorId,
    at: now,
  });
  await batch.commit();
  return Response.json({ uid: m.uid, permittedSiteIds });
});
