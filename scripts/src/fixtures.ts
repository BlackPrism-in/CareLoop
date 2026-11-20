import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FixtureBundle } from '@careloop/contracts';
import { caseFingerprint } from '@careloop/domain';

export const DEMO_FIXTURE_PATH = fileURLToPath(
  new URL('../../evals/fixtures/demo-tenant.json', import.meta.url),
);

/** Parses and validates a fixture, including that stored fingerprints match the domain function. */
export function loadFixture(path = DEMO_FIXTURE_PATH): FixtureBundle {
  const bundle = FixtureBundle.parse(JSON.parse(readFileSync(path, 'utf8')));
  const sources = new Map(bundle.sources.map((s) => [s.sourceId, s]));
  for (const c of bundle.cases) {
    const src = sources.get(c.sourceId)!;
    const expected = caseFingerprint({
      tenantId: bundle.tenant.tenantId,
      sourceAuthority: src.sourceAuthority,
      sourceReference: src.reference,
      obligationKey: c.actionType,
    });
    if (c.fingerprint !== expected)
      throw new Error(`fixture case ${c.caseId} has a stale fingerprint`);
  }
  return bundle;
}
