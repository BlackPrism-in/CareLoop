import type { Case, Member, Patient } from '@careloop/contracts';
import { tenantCollection, tenantRecord, type HandoffDoc } from '@careloop/domain';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';
import { filterBySite } from '@/server/case-helpers';

export const dynamic = 'force-dynamic';

/** Human queue: open handoffs with owner, deadline, overdue and backup status. */
export const GET = staffRoute(async ({ req, session }) => {
  const db = firestore();
  const t = session.ctx.tenantId;
  const status =
    new URL(req.url).searchParams.get('status') === 'resolved'
      ? ['RESOLVED']
      : ['PENDING', 'ACKNOWLEDGED'];
  const snap = await db
    .collection(tenantCollection(t, 'handoffs'))
    .where('status', 'in', status)
    .limit(100)
    .get();
  const rows = await filterBySite(t, snap.docs
    .map((d) => d.data() as HandoffDoc)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt)), session.ctx.siteIds);
  const cases = rows.length
    ? await db.getAll(
        ...[...new Set(rows.map((r) => r.caseId))].map((id) =>
          db.doc(tenantRecord(t, 'cases', id)),
        ),
      )
    : [];
  const caseMap = new Map(cases.filter((c) => c.exists).map((c) => [c.id, c.data() as Case]));
  const pIds = [...new Set([...caseMap.values()].map((c) => c.patientId))];
  const patients = pIds.length
    ? await db.getAll(...pIds.map((id) => db.doc(tenantRecord(t, 'patients', id))))
    : [];
  const alias = new Map(
    patients.filter((p) => p.exists).map((p) => [p.id, (p.data() as Patient).alias]),
  );
  const members = (await db.collection(tenantCollection(t, 'members')).get()).docs.map(
    (m) => m.data() as Member,
  );
  const name = new Map(members.map((m) => [m.uid, m.displayName]));
  const now = Date.now();
  return Response.json({
    items: rows.map((h) => {
      const c = caseMap.get(h.caseId);
      return {
        ...h,
        ownerName: name.get(h.ownerId) ?? h.ownerId,
        acknowledgedByName: h.acknowledgedBy
          ? (name.get(h.acknowledgedBy) ?? h.acknowledgedBy)
          : null,
        patientAlias: c ? (alias.get(c.patientId) ?? 'Unknown patient') : 'Unknown patient',
        caseVersion: c?.version ?? null,
        workflowState: c?.workflowState ?? null,
        overdue: h.status === 'PENDING' && Date.parse(h.dueAt) < now,
      };
    }),
    members: members
      .filter((m) => m.status === 'ACTIVE' && !m.roleSet.every((r) => r === 'AUDITOR'))
      .map((m) => ({ uid: m.uid, displayName: m.displayName })),
  });
});
