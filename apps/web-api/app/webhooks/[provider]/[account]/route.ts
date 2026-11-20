import { loadConfig } from '@careloop/contracts';
import { ingestProviderWebhook, SIGNATURE_HEADER } from '@careloop/jobs';
import { createLogger } from '@careloop/observability';
import { firestore } from '@/server/firebase';
import { jobRuntime } from '@/server/services';

export const dynamic = 'force-dynamic';
const log = createLogger('careloop-web-api');

/**
 * Provider callbacks (MVP spec §15). The signature is checked over the raw
 * body; the tenant comes from the configured account, never the payload.
 * Accepted events are stored durably and processed asynchronously (202).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ provider: string; account: string }> },
) {
  const { provider, account } = await ctx.params;
  const raw = await req.text();
  if (raw.length > 64_000) return Response.json({ status: 'REJECTED' }, { status: 413 });
  const r = await ingestProviderWebhook(
    {
      db: firestore(),
      secrets: loadConfig().WEBHOOK_SIGNING_SECRETS,
      dispatcher: jobRuntime().dispatcher,
      log,
    },
    { provider, account, rawBody: raw, signature: req.headers.get(SIGNATURE_HEADER) },
  );
  return Response.json({ status: r.status }, { status: r.httpStatus });
}
