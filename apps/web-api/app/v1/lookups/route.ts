import { loadConfig } from '@careloop/contracts';
import { staffRoute } from '@/server/handler';
import { queries } from '@/server/services';

export const dynamic = 'force-dynamic';

/** Pickers for the New follow-up form: aliases and ids only, scoped to the caller's lab. */
export const GET = staffRoute(async ({ session }) =>
  Response.json({
    ...(await queries().lookups(session.ctx.tenantId, session.ctx.siteIds)),
    enabledLanguages: loadConfig().ENABLED_LANGUAGES,
  }),
);
