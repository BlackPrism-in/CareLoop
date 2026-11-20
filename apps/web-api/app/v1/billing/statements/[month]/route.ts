import { statementCsv, tenantRecord, type BillingStatement } from '@careloop/domain';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { staffRoute } from '@/server/handler';

export const dynamic = 'force-dynamic';

/** One statement, as JSON or CSV (?format=csv). Owner only. */
export const GET = staffRoute<{ month: string }>(async ({ req, session, params }) => {
  if (!session.ctx.roles.includes('OWNER')) throw new HttpError('FORBIDDEN', 'Only an owner can see billing');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(params.month)) throw new HttpError('NOT_FOUND', 'Statement not found');
  const s = (await firestore().doc(tenantRecord(session.ctx.tenantId, 'invoices', params.month)).get()).data() as BillingStatement | undefined;
  if (!s) throw new HttpError('NOT_FOUND', 'Statement not found');
  if (new URL(req.url).searchParams.get('format') === 'csv')
    return new Response(statementCsv(s), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="careloop-statement-${s.month}.csv"` },
    });
  return Response.json(s);
});
