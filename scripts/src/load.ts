/**
 * API load test (MVP spec §20: p95 < 500 ms for ordinary reads, excluding
 * model/provider work). Read-only: lists, case detail, overview.
 *   WEB_URL=… LOAD_TOKEN=<staff ID token> LOAD_CASE_ID=CL-2002 [LOAD_CONCURRENCY=10] [LOAD_SECONDS=30]
 * Results from the emulators are a smoke baseline, not production numbers.
 */
const web = process.env.WEB_URL?.replace(/\/$/, '');
const token = process.env.LOAD_TOKEN;
const caseId = process.env.LOAD_CASE_ID;
if (!web || !token || !caseId) {
  console.error('Set WEB_URL, LOAD_TOKEN and LOAD_CASE_ID');
  process.exit(2);
}
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 10);
const seconds = Number(process.env.LOAD_SECONDS ?? 30);
const paths = ['/v1/cases?limit=25', `/v1/cases/${caseId}`, '/v1/overview', '/v1/handoffs'];
const lat: Record<string, number[]> = Object.fromEntries(paths.map((p) => [p, []]));
let errors = 0;
const end = Date.now() + seconds * 1000;

async function worker(i: number) {
  let n = i;
  while (Date.now() < end) {
    const p = paths[n++ % paths.length]!;
    const t0 = performance.now();
    try {
      const r = await fetch(`${web}${p}`, { headers: { authorization: `Bearer ${token}` } });
      await r.arrayBuffer();
      if (!r.ok) errors++;
    } catch {
      errors++;
    }
    lat[p]!.push(performance.now() - t0);
  }
}
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0);
};
const all = Object.values(lat).flat();
console.log(
  `concurrency ${concurrency} · ${seconds}s · ${all.length} requests · ${(all.length / seconds).toFixed(1)} req/s · errors ${errors}`,
);
for (const p of paths)
  console.log(
    `${p.padEnd(28)} p50 ${pct(lat[p]!, 0.5)} ms · p95 ${pct(lat[p]!, 0.95)} ms · p99 ${pct(lat[p]!, 0.99)} ms`,
  );
console.log(
  `ALL                          p50 ${pct(all, 0.5)} ms · p95 ${pct(all, 0.95)} ms · target p95 < 500 ms: ${pct(all, 0.95) < 500 && errors === 0 ? 'MET' : 'NOT MET'}`,
);

export {};
