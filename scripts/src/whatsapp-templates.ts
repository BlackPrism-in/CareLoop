import { PATIENT_TEMPLATES } from '@careloop/adapters';

/**
 * Submits CareLoop's WhatsApp templates (English and Hindi) to Meta for review,
 * or with --status lists their review status. Safe to re-run: existing
 * templates are reported, not duplicated.
 *
 *   WHATSAPP_ACCESS_TOKEN=... pnpm --filter @careloop/scripts whatsapp-templates --waba <WABA_ID> [--status]
 *
 * The token is read from the environment only and never printed. Pipe it from
 * Secret Manager rather than typing it:
 *   WHATSAPP_ACCESS_TOKEN="$(gcloud secrets versions access latest --secret=whatsapp-access-token)" ...
 */
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const waba = arg('waba');
const token = process.env.WHATSAPP_ACCESS_TOKEN;
const version = process.env.WHATSAPP_GRAPH_VERSION ?? 'v25.0';
/** Where the invite's button opens: the get-the-app page. */
const appUrl = arg('app-url') ?? 'https://careloop-web-api-94524397144.asia-south1.run.app/app';
if (!waba || !/^\d+$/.test(waba) || !token) {
  console.error(
    'Usage: WHATSAPP_ACCESS_TOKEN=... whatsapp-templates --waba <WhatsApp Business Account ID> [--status]',
  );
  process.exit(2);
}
const graph = async (path: string, init?: RequestInit) => {
  const r = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const j = (await r.json()) as Record<string, unknown> & {
    error?: { message?: string; code?: number; error_user_msg?: string };
  };
  if (!r.ok)
    throw new Error(
      `Meta ${j.error?.code ?? r.status}: ${j.error?.error_user_msg ?? j.error?.message ?? 'error'}`,
    );
  return j;
};

type Existing = { name: string; language: string; status: string; category: string };
const existing = (
  (await graph(`${waba}/message_templates?fields=name,language,status,category&limit=200`)) as {
    data: Existing[];
  }
).data.filter((t) => t.name.startsWith('careloop_'));

if (process.argv.includes('--status')) {
  const marketing = existing.filter((t) => t.category === 'MARKETING');
  if (marketing.length)
    console.log(`WARNING: ${marketing.length} careloop_ template(s) are MARKETING (paid).`);
  for (const t of existing)
    console.log(`${t.status.padEnd(10)} ${t.name} (${t.language}, ${t.category})`);
  if (!existing.length) console.log('No careloop_ templates yet.');
  process.exit(0);
}

for (const def of Object.values(PATIENT_TEMPLATES)) {
  for (const language of def.languages ?? (['en', 'hi'] as const)) {
    if (existing.some((t) => t.name === def.name && t.language === language)) {
      console.log(`exists     ${def.name} (${language})`);
      continue;
    }
    const components =
      def.category === 'AUTHENTICATION'
        ? [
            { type: 'BODY', add_security_recommendation: true },
            { type: 'FOOTER', code_expiration_minutes: 10 },
            { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
          ]
        : [
            { type: 'BODY', text: def.body[language], example: { body_text: [def.examples] } },
            ...(def.urlButton
              ? [
                  {
                    type: 'BUTTONS',
                    buttons: [{ type: 'URL', text: def.urlButton[language], url: appUrl }],
                  },
                ]
              : []),
          ];
    try {
      const r = await graph(`${waba}/message_templates`, {
        method: 'POST',
        body: JSON.stringify({ name: def.name, language, category: def.category, components }),
      });
      // No paid MARKETING templates: if Meta re-files one as marketing, delete it.
      if (r.category === 'MARKETING' && typeof r.id === 'string') {
        await graph(`${waba}/message_templates?name=${def.name}&hsm_id=${r.id}`, {
          method: 'DELETE',
        });
        console.log(`DELETED    ${def.name} (${language}): Meta filed it as MARKETING (paid)`);
        continue;
      }
      console.log(`submitted  ${def.name} (${language}): ${String(r.status ?? 'PENDING')}`);
    } catch (e) {
      console.log(`FAILED     ${def.name} (${language}): ${(e as Error).message}`);
    }
  }
}
process.exit(0);
