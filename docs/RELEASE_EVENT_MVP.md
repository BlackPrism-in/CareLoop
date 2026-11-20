# Event MVP release report

**Date:** 20 Nov 2026 · **Scope:** synthetic data only (MVP spec §02 "Event MVP")

**Verdict:** the release gate **passes locally**. The Event MVP is ready to demo on the emulators. It is **not** pilot-ready (see "Not done").

## Release gate (MVP spec §02, §21)
| Check | Result |
|---|---|
| Scenario suite (`pnpm eval`): 64 synthetic scenarios, 32 Hindi + 32 English, 12 categories | **64/64 pass** |
| Unauthorized contact across the suite | **0** |
| Duplicate reservation across the suite | **0** |
| False verified completion across the suite | **0** |
| Unit tests (`pnpm test`) | 93 pass |
| Emulator suites (`pnpm test:emulator`): domain 35, jobs 20, voice 9, API 21 | 85 pass |
| Production builds boot (`scripts/check-bundles.sh`) | pass |
| Terraform validate | pass |

Detailed per-scenario results are in [`evals/reports/latest.md`](../evals/reports/latest.md). The scenario suite runs scripted model doubles that include **deliberately non-compliant behaviour**: inventing slots, claiming a booking early, being asked medical questions, injected instructions. It measures what the system enforces, **not** model quality. A passing suite is a test result, not proof that nothing can ever fail.

## Acceptance criteria (MVP spec §02)
| ID | Covered by |
|---|---|
| MVP-01 create | domain suite, API suite, eval D1 |
| MVP-02 approve | domain suite, API suite, eval A1/A2, browser check (Phase 2) |
| MVP-03 execution-time checks | domain suite, eval U2/O2/O3 |
| MVP-04 adapter slots + confirmation | API suite, voice suite, eval N2/P3 |
| MVP-05 booked only on acknowledgment | jobs suite, eval T1/T2/D2 |
| MVP-06 medical question | voice suite, eval M1–M3 (EN + HI) |
| MVP-07 opt-out | domain/jobs/API suites, eval O1–O3 |
| MVP-08 evidence matching | jobs suite, eval E1–E5, browser check (Phase 5) |
| MVP-09 verified completion | domain/API suites, eval E3/H1/H2 |
| MVP-10 duplicates | jobs suite, eval D2 |
| MVP-11 handoff ≠ completion | domain/API suites, eval I2/N1/U1 |
| MVP-12 separate counts | API suite (reports), browser check (Phase 6) |

## Versions
- **Prompts:** `intake-v1`, `conversation-v1`, `coordination-v1`, `verification-v1`.
- **Models (configured, not yet called):** `gemini-3.5-flash-lite` (intake), `gemini-3.8-flash` (coordination, verification), `gemini-3.8-live` (conversation). Locations: text `global`, Live `us-central1`.

## Fixed during this release
- **Safety:** ending a call after the patient opted out recorded "reached" and **overwrote the opt-out**. A suppression can now never be overwritten. Found by eval O1, with a regression test added.
- **Deployment:** the bundled worker and voice services **crashed on start** (`__dirname` in ESM). They would have failed in Cloud Run. Fixed, and CI now boots every production build.
- **Deployment:** the web image lacked the browser Firebase config. It's now passed as build arguments.

## Not done / known limitations
1. **No real Gemini call has been made.** Run `pnpm check:models`, then `EVAL_LIVE_MODELS=1 pnpm eval` to fill in the single-model vs multi-model benchmark rows. Until then only the rules baseline is measured: coordination **10/12**; it misses day-of-week preferences.
2. **Live voice quality is unmeasured:** Hindi and English accents, interruptions, latency (p95 target < 2 s) and script adherence. Bengali stays disabled (Google lists only `bn-BD` for Live).
3. **Staging has never been deployed.** The pipeline is written but inactive until the GitHub variables in [DEPLOY.md](DEPLOY.md) are set. Docker images weren't built locally (the Docker daemon was off), although the same production builds boot.
4. **Identity verification is simulated** (supervised button). A real method must be agreed with the lab before a pilot.
5. **Not built (pilot phase):** PSTN calling (Exotel) and WhatsApp, PDF and CSV intake, staff MFA, retention and deletion jobs, the monitoring dashboard, and the restore drill.
6. **Reports** scan up to 2,000 cases per query, which is fine for demo scale. Staff minutes per 100 cases need a timed pilot baseline.
7. **This Mac's dev servers** reload in a loop because of outside file events on `~/Desktop`. Demo with the production build ([DEMO.md](DEMO.md)).

## Reproduce
```bash
pnpm check && pnpm test:emulator && pnpm eval && pnpm build && ./scripts/check-bundles.sh
```
