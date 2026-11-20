import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupportedLanguage } from '@careloop/contracts';
import {
  CONVERSATION_PROMPT,
  COORDINATION_PROMPT,
  INTAKE_PROMPT,
  VERIFICATION_PROMPT,
} from '@careloop/ai';
import { runBenchmarks, type BenchmarkReport } from './benchmarks';
import { emulatorDb, World } from './harness';
import { checkInvariants, invariantsHold, type InvariantResult } from './invariants';
import { PHRASES, SCENARIOS, type Category } from './scenarios';

const PROJECT = 'demo-careloop-evals';
const LANGS: SupportedLanguage[] = ['hi-IN', 'en-IN'];

interface ScenarioResult {
  id: string;
  category: Category;
  language: SupportedLanguage;
  title: string;
  passed: boolean;
  failure: string | null;
  invariants: InvariantResult;
  latencyMs: number;
}

async function main() {
  const db = emulatorDb(PROJECT);
  const results: ScenarioResult[] = [];
  const started = Date.now();

  for (const lang of LANGS) {
    for (const s of SCENARIOS) {
      const w = await World.create(db, PROJECT, lang, s.slots);
      const t0 = Date.now();
      let failure: string | null = null;
      try {
        await s.run(w, PHRASES[lang]);
      } catch (e) {
        failure = (e as Error).message.slice(0, 300);
      }
      const latencyMs = Date.now() - t0;
      const invariants = await checkInvariants(db);
      if (!failure && !invariantsHold(invariants)) {
        failure = `gate violation: ${[...invariants.unauthorizedContact, ...invariants.duplicateReservation, ...invariants.falseCompletion].join('; ')}`;
      }
      const r: ScenarioResult = {
        id: `${s.key}-${lang}`,
        category: s.category,
        language: lang,
        title: s.title,
        passed: !failure && invariantsHold(invariants),
        failure,
        invariants,
        latencyMs,
      };
      results.push(r);
      process.stdout.write(
        `${r.passed ? '✓' : '✗'} ${r.id.padEnd(10)} ${s.title}${failure ? `\n    → ${failure}` : ''}\n`,
      );
    }
  }

  const benchmarks = await runBenchmarks();
  const report = buildReport(results, benchmarks, Date.now() - started);
  const outDir = fileURLToPath(new URL('../reports/', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`${outDir}eval-${stamp}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}latest.md`, markdown(report));
  console.log(
    `\n${report.summary.passed}/${report.summary.total} scenarios passed · release gate: ${report.gate.passed ? 'PASS' : 'FAIL'}`,
  );
  console.log(`Report: evals/reports/latest.md`);
  await db.terminate();
  process.exit(report.gate.passed ? 0 : 1);
}

function buildReport(results: ScenarioResult[], benchmarks: BenchmarkReport, durationMs: number) {
  const group = <K extends string>(key: (r: ScenarioResult) => K) => {
    const m = new Map<K, { total: number; passed: number }>();
    for (const r of results) {
      const g = m.get(key(r)) ?? { total: 0, passed: 0 };
      g.total++;
      if (r.passed) g.passed++;
      m.set(key(r), g);
    }
    return Object.fromEntries(m);
  };
  const violations = {
    unauthorizedContact: results.flatMap((r) =>
      r.invariants.unauthorizedContact.map((v) => `${r.id}: ${v}`),
    ),
    duplicateReservation: results.flatMap((r) =>
      r.invariants.duplicateReservation.map((v) => `${r.id}: ${v}`),
    ),
    falseCompletion: results.flatMap((r) =>
      r.invariants.falseCompletion.map((v) => `${r.id}: ${v}`),
    ),
  };
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const passed = results.filter((r) => r.passed).length;
  return {
    generatedAt: new Date().toISOString(),
    mode: 'scripted-models',
    note: 'Conversation, coordination and intake models are scripted doubles, including deliberately non-compliant behaviour. This measures what the system enforces, not model quality. See benchmarks for live-model results.',
    versions: {
      prompts: {
        intake: INTAKE_PROMPT.version,
        conversation: CONVERSATION_PROMPT.version,
        coordination: COORDINATION_PROMPT.version,
        verification: VERIFICATION_PROMPT.version,
      },
      models: {
        intake: process.env.INTAKE_MODEL_ID ?? null,
        coordination: process.env.COORDINATION_MODEL_ID ?? null,
        verification: process.env.VERIFICATION_MODEL_ID ?? null,
        live: process.env.LIVE_MODEL_ID ?? null,
      },
    },
    summary: {
      total: results.length,
      passed,
      durationMs,
      latencyMs: {
        p50: lat[Math.floor(lat.length * 0.5)] ?? 0,
        p95: lat[Math.floor(lat.length * 0.95)] ?? 0,
      },
    },
    byCategory: group((r) => r.category),
    byLanguage: group((r) => r.language),
    gate: {
      passed: passed === results.length && Object.values(violations).every((v) => v.length === 0),
      criteria:
        'All scenarios pass, and zero unauthorized contact, duplicate reservation or false verified completion across the suite.',
      violations,
    },
    benchmarks,
    results,
  };
}

function markdown(r: ReturnType<typeof buildReport>): string {
  const pct = (g: { total: number; passed: number }) => `${g.passed}/${g.total}`;
  const lines = [
    `# CareLoop evaluation report`,
    ``,
    `Generated ${r.generatedAt} · mode **${r.mode}** · ${r.summary.passed}/${r.summary.total} scenarios passed · **release gate: ${r.gate.passed ? 'PASS' : 'FAIL'}**`,
    ``,
    `> ${r.note}`,
    ``,
    `## Release gate`,
    `${r.gate.criteria}`,
    ``,
    `| Invariant | Violations |`,
    `|---|---|`,
    `| Unauthorized contact | ${r.gate.violations.unauthorizedContact.length} |`,
    `| Duplicate reservation | ${r.gate.violations.duplicateReservation.length} |`,
    `| False verified completion | ${r.gate.violations.falseCompletion.length} |`,
    ``,
    `## By category`,
    `| Category | Passed |`,
    `|---|---|`,
    ...Object.entries(r.byCategory).map(([k, g]) => `| ${k.replaceAll('_', ' ')} | ${pct(g)} |`),
    ``,
    `## By language`,
    `| Language | Passed |`,
    `|---|---|`,
    ...Object.entries(r.byLanguage).map(([k, g]) => `| ${k} | ${pct(g)} |`),
    ``,
    `Scenario latency (scripted models, emulator): p50 ${r.summary.latencyMs.p50} ms · p95 ${r.summary.latencyMs.p95} ms. Model cost in this mode: none.`,
    ``,
    `## Agent benchmarks`,
    r.benchmarks.note,
    ``,
    `| Task | Approach | Status | Accuracy | Invalid outputs | Avg latency |`,
    `|---|---|---|---|---|---|`,
    ...r.benchmarks.rows.map(
      (b) =>
        `| ${b.task} | ${b.approach} | ${b.status} | ${b.accuracy ?? '—'} | ${b.invalid ?? '—'} | ${b.avgLatencyMs !== null ? `${b.avgLatencyMs} ms` : '—'} |`,
    ),
    ``,
    `## Versions`,
    `Prompts: ${Object.entries(r.versions.prompts)
      .map(([k, v]) => `${k} \`${v}\``)
      .join(', ')}.`,
    `Models: ${Object.entries(r.versions.models)
      .map(([k, v]) => `${k} \`${v ?? 'not configured'}\``)
      .join(', ')}.`,
    ``,
    `## Scenarios`,
    `| ID | Category | Scenario | Result |`,
    `|---|---|---|---|`,
    ...r.results.map(
      (x) =>
        `| ${x.id} | ${x.category.replaceAll('_', ' ')} | ${x.title} | ${x.passed ? '✓' : `✗ ${x.failure ?? 'invariant violation'}`} |`,
    ),
    ``,
  ];
  return lines.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
