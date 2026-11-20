import { loadConfig } from '@careloop/contracts';
import { configuredModels, createGenAIClient } from '@careloop/ai';

/**
 * Phase 0 exit check: every configured model ID resolves on the selected API
 * surface/location, and the text models answer a trivial, non-clinical prompt.
 * Live is resolved only (a Live session needs the voice gateway, Phase 4).
 */
const cfg = loadConfig();
const text = createGenAIClient(cfg);
const live = createGenAIClient(cfg, { purpose: 'live' });
console.log(
  `API surface: ${cfg.GOOGLE_API_SURFACE}  project: ${cfg.GOOGLE_CLOUD_PROJECT}  ` +
    `text location: ${cfg.GOOGLE_CLOUD_LOCATION}  live location: ${cfg.LIVE_MODEL_LOCATION}`,
);

let failed = false;
for (const [role, id] of Object.entries(configuredModels(cfg))) {
  const isLive = role === 'CONVERSATION';
  const client = isLive ? live : text;
  let status: string;
  try {
    await client.models.get({ model: id });
    status = 'resolved';
    if (!isLive) {
      const t0 = Date.now();
      const r = await client.models.generateContent({
        model: id,
        contents: 'Reply with the single word: ready',
      });
      status += `, answered "${(r.text ?? '').trim().slice(0, 20)}" in ${Date.now() - t0}ms`;
    }
    console.log(`OK    ${role.padEnd(13)} ${id}  (${status})`);
  } catch (e) {
    failed = true;
    console.log(`FAIL  ${role.padEnd(13)} ${id}  ${(e as Error).message.slice(0, 160)}`);
  }
}
process.exit(failed ? 1 : 0);
