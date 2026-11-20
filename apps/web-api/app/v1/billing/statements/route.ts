import { randomUUID } from 'node:crypto';
import { tenantCollection, tenantRecord, type BillingStatement } from '@careloop/domain';
import { issueStatement } from '@/server/billing';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { StatementBody } from '@/server/schemas';

export const dynamic = 'force-dynamic';

const ownerOnly = (roles: readonly string[]) => {
  if (!roles.includes('OWNER')) throw new HttpError('FORBIDDEN', 'Only an owner can see billing');
};

/** Issued monthly statements, newest first (without the case id lists). */
export const GET = staffRoute(async ({ session }) => {
  ownerOnly(session.ctx.roles);
  const snap = await firestore().collection(tenantCollection(session.ctx.tenantId, 'invoices')).get();
  const items = snap.docs
    .map((d) => d.data() as BillingStatement)
    .map(({ caseIds, ...s }) => ({ ...s, enrolledCases: caseIds.length }))
    .sort((a, b) => b.month.localeCompare(a.month));
  return Response.json({ items });
});

/** Issues the statement for a finished month. Repeating it returns the same statement. Audited. */
export const POST = staffRoute(async ({ req, session }) => {
  ownerOnly(session.ctx.roles);
  const { month } = StatementBody.parse(await jsonBody(req));
  const { statement, created } = await issueStatement(session.ctx.tenantId, month, session.ctx.actorId);
  if (created) {
    const auditId = randomUUID();
    await firestore().doc(tenantRecord(session.ctx.tenantId, 'audit', auditId)).set({ auditId, action: 'STATEMENT_ISSUED', month, totalInr: statement.totalInr, actorId: session.ctx.actorId, at: statement.issuedAt });
  }
  const { caseIds, ...rest } = statement;
  return Response.json({ ...rest, enrolledCases: caseIds.length }, { status: created ? 201 : 200 });
});
