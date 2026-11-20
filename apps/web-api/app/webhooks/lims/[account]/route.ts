import { SIGNATURE_HEADER } from '@careloop/jobs';
import { createLogger } from '@careloop/observability';
import { ingestLimsOrder } from '@/server/lims';

export const dynamic = 'force-dynamic';
const log = createLogger('careloop-web-api');

/**
 * LIMS / hospital order feed: signed JSON or HL7 v2 ORM^O01 (one order per
 * request). Creates DRAFT cases only; a reviewer approves before any contact.
 */
export async function POST(req: Request, ctx: { params: Promise<{ account: string }> }) {
  const { account } = await ctx.params;
  const raw = await req.text();
  if (raw.length > 64_000) return Response.json({ status: 'REJECTED' }, { status: 413 });
  const r = await ingestLimsOrder({
    account,
    rawBody: raw,
    contentType: req.headers.get('content-type') ?? '',
    signature: req.headers.get(SIGNATURE_HEADER),
  });
  if (r.http >= 400) log.warn('lims order rejected', { account, reason: r.reason });
  return Response.json(
    { status: r.status, caseId: r.caseId ?? null, reason: r.reason ?? null },
    { status: r.http },
  );
}
