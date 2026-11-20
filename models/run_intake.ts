// Usage: corepack pnpm eval:models
// Runs the regex baseline always; runs Gemini only if GEMINI_API_KEY + FLASH_LITE_MODEL_ID are set.
import { seeds, IntakeSeed } from './intake_seed';
import { REQUIRED_FIELD_KEYS, normalizeDate, normalizePhone } from './validate';
import { runIntake } from './run';
import { createGeminiIntakeModel } from './model';

type KV = { key: string; value: string };
type Extraction = {
  fields: KV[];
  spanCount?: number;
  validSpanCount?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  duplicateFingerprint?: string | null;
  validationWarnings?: string[];
};
type Extractor = (seed: IntakeSeed) => Promise<Extraction>;
const requestedIds = process.env.EVAL_CASE_IDS?.split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const evalSeeds = requestedIds?.length
  ? seeds.filter((seed) => requestedIds.includes(seed.id))
  : seeds;

// Rules-only baseline. If Flash-Lite can't beat this, we cut the agent.
const regexExtractor: Extractor = async ({ sourceText: t }) => {
  const out: KV[] = [];
  const add = (key: string, value?: string | null) => value && out.push({ key, value });

  for (const m of t.matchAll(/\d[\d\s-]{8,12}\d/g)) {
    const p = normalizePhone(m[0]);
    if (p) {
      add('patient_phone', p);
      break;
    }
  }
  add('due_date', normalizeDate(t.match(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/)?.[0] ?? ''));
  add('source_ref', t.match(/\bSDL-\d+\b/)?.[0]);
  add('ordering_clinician', t.match(/\bDr\.?\s+(?:[A-Z]\.\s*)*[A-Z][a-z]+/)?.[0]);
  add('patient_name', t.match(/(?:Patient:?|Pt:?|Mareez:)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/)?.[1]);
  add(
    'action_name',
    t.match(
      /\b(lipid profile|thyroid test|vitamin B12|vitamin D|ferritin|HbA1c|TSH|ECG|CBC)\b/i,
    )?.[0],
  );
  if (/\b(ordered|order|likha|likhi|likhe|karana|karwana)\b/i.test(t))
    add('action_type', 'ordered_test');
  else if (/\b(consultation|consult|appointment)\b/i.test(t)) {
    add('action_type', 'consultation');
    add('action_name', t.match(/\b(consultation|appointment)\b/i)?.[0]);
  }
  add('patient_ref', t.match(/\b(?:MRN|Patient\s*Ref)\s*[:#]?\s*([A-Z0-9-]+)\b/i)?.[1]);
  add(
    'preferred_language',
    t.match(/\b(?:preferred language|language)\s*[:=]?\s*(English|Hindi|Bengali|Hinglish)\b/i)?.[1],
  );
  return { fields: out };
};

function geminiExtractor(): Extractor | null {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelId = process.env.FLASH_LITE_MODEL_ID;
  if (!apiKey || !modelId) return null;
  const model = createGeminiIntakeModel({ apiKey, modelId });
  return async (seed) => {
    const r = await runIntake(
      { tenantId: 'eval-tenant', caseDraftId: seed.id, sourceText: seed.sourceText },
      { model, synthetic: true, now: () => new Date('2026-11-20T00:00:00.000Z') },
    );
    if (r.status === 'manual_entry') {
      console.warn(`Gemini fallback for ${seed.id}: ${r.reason.slice(0, 240)}`);
      return { fields: [] };
    }
    return {
      fields: r.proposal.fields.map((f) => ({ key: f.key, value: f.value })),
      spanCount: r.proposal.fields.length,
      validSpanCount: r.proposal.fields.filter(
        (f) => seed.sourceText.slice(f.sourceSpan.start, f.sourceSpan.end) === f.sourceSpan.quote,
      ).length,
      latencyMs: r.proposal.meta.latencyMs,
      inputTokens: r.proposal.meta.inputTokens,
      outputTokens: r.proposal.meta.outputTokens,
      duplicateFingerprint: r.proposal.duplicateFingerprint,
      validationWarnings: r.proposal.warnings,
    };
  };
}

async function evaluate(name: string, extract: Extractor) {
  let tp = 0,
    fp = 0,
    fn = 0,
    leaks = 0,
    missingOk = 0;
  let spans = 0,
    validSpans = 0,
    latencyTotal = 0,
    latencyCases = 0,
    inputTokens = 0,
    outputTokens = 0,
    tokenCases = 0;
  const duplicateFingerprints: string[] = [];
  for (const s of evalSeeds) {
    const extraction = await extract(s);
    const got = extraction.fields;
    const validationWarnings = (extraction.validationWarnings ?? []).filter((warning) =>
      /Dropped|Conflicting|Repaired/i.test(warning),
    );
    if (validationWarnings.length)
      console.log(`${name} ${s.id} validation: ${validationWarnings.join(' ')}`);
    if (s.category === 'duplicate' && extraction.duplicateFingerprint)
      duplicateFingerprints.push(extraction.duplicateFingerprint);
    spans += extraction.spanCount ?? 0;
    validSpans += extraction.validSpanCount ?? 0;
    if (extraction.latencyMs !== undefined) {
      latencyTotal += extraction.latencyMs;
      latencyCases++;
    }
    if (extraction.inputTokens !== undefined) {
      inputTokens += extraction.inputTokens;
      tokenCases++;
    }
    if (extraction.outputTokens !== undefined) outputTokens += extraction.outputTokens;
    const g = new Set(got.map((x) => `${x.key}=${x.value}`));
    const e = new Set(s.expected.map((x) => `${x.key}=${x.value}`));
    for (const x of g) e.has(x) ? tp++ : fp++;
    for (const x of e) if (!g.has(x)) fn++;
    const unexpected = [...g].filter((x) => !e.has(x));
    const missingExpected = [...e].filter((x) => !g.has(x));
    if (unexpected.length || missingExpected.length) {
      console.log(
        `${name} ${s.id}: ${[
          unexpected.length ? `unexpected: ${unexpected.join(', ')}` : '',
          missingExpected.length ? `missing: ${missingExpected.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; ')}`,
      );
    }
    const blob = got.map((x) => x.value.toLowerCase()).join(' | ');
    if ((s.mustNotExtract ?? []).some((m) => blob.includes(m.toLowerCase()))) leaks++;
    const present = new Set(got.map((x) => x.key));
    const missing = REQUIRED_FIELD_KEYS.filter((k) => !present.has(k)).sort();
    if (JSON.stringify(missing) === JSON.stringify([...s.expectedMissing].sort())) missingOk++;
  }
  const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
  console.log(`\n== ${name} (${evalSeeds.length} cases) ==`);
  console.log(`precision        ${pct(tp, tp + fp)}`);
  console.log(`recall           ${pct(tp, tp + fn)}`);
  console.log(`wrong/extra      ${fp}   (target 0 hallucinated)`);
  console.log(`forbidden leaks  ${leaks}   (target 0)`);
  console.log(`missing correct  ${pct(missingOk, evalSeeds.length)}`);
  console.log(`span validity    ${pct(validSpans, spans)}`);
  console.log(
    `avg latency      ${latencyCases ? `${(latencyTotal / latencyCases).toFixed(0)}ms` : 'n/a'}`,
  );
  console.log(
    `avg tokens       ${tokenCases ? `${(inputTokens / tokenCases).toFixed(0)} in / ${(outputTokens / tokenCases).toFixed(0)} out` : 'n/a'}`,
  );
  const expectedDuplicateCount = evalSeeds.filter((seed) => seed.category === 'duplicate').length;
  console.log(
    `duplicate match  ${expectedDuplicateCount ? `${duplicateFingerprints.length === expectedDuplicateCount && new Set(duplicateFingerprints).size === 1 ? 'pass' : 'fail'} (${duplicateFingerprints.length}/${expectedDuplicateCount} fingerprints)` : 'n/a'}`,
  );
  const inputRate = Number(process.env.FLASH_LITE_INPUT_USD_PER_MILLION);
  const outputRate = Number(process.env.FLASH_LITE_OUTPUT_USD_PER_MILLION);
  if (
    name.includes('gemini') &&
    Number.isFinite(inputRate) &&
    Number.isFinite(outputRate) &&
    tokenCases
  ) {
    const cost = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000 / tokenCases;
    console.log(`est. cost/case  $${cost.toFixed(6)} (set per-million token rates in models/.env)`);
  } else {
    console.log('est. cost/case  n/a (set FLASH_LITE_*_USD_PER_MILLION rates to estimate)');
  }
}

(async () => {
  await evaluate('regex baseline', regexExtractor);
  const gem = geminiExtractor();
  if (gem) await evaluate('gemini flash-lite', gem);
  else console.log('\n(skipping Gemini: set GEMINI_API_KEY and FLASH_LITE_MODEL_ID)');
})();
