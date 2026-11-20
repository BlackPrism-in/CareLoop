# CareLoop — Phased Delivery Roadmap

Source documents: `CareLoop_Final_Blueprint.pdf` (v1, 7 Nov 2026) and `CareLoop_MVP_Architecture_System_Design.pdf` (MVP spec v1.0, 7 Nov 2026).
Acceptance IDs (`MVP-01`…`MVP-12`) and section numbers (`§`) refer to the MVP spec.

**Product in one line:** a multilingual AI follow-up coordinator that turns a clinician-approved, non-urgent next step (consultation or already-ordered test) into a booked and *independently verified* completion for independent Indian diagnostic labs.

**Non-negotiables that apply to every phase**
- No diagnosis, result interpretation, triage, medical advice, or test selection. Critical results stay in the lab's human workflow.
- Booking ≠ completion. Handoff acknowledgment ≠ completion. Self-report ≠ verified.
- Model output is a *proposal*; only deterministic domain commands change state.
- Tenant comes from server-side membership, never from the client or a webhook payload.
- Every state-changing command carries `expectedVersion` + an idempotency key.
- Simulated events, bookings and messages are always labeled as such.

**Timeline context (from the blueprint):** applications closed 13 Nov; City Buildathon 20–21 Nov; regional showcases 23/25/27 Nov; finale 2 Dec. Phases 1–6 are the **Event MVP** (synthetic data only). Phases 7–8 are the **Pilot release** (real patients). Phase 9 is post-adoption.

---

## Phase 0 — Foundations & pre-build decisions
**Goal:** everything needed so build days are spent on the loop, not setup.

| Area | Work |
|---|---|
| Rules | Confirm with organizer which code/assets may be prebuilt; disclose reuse. |
| Google | Billing-enabled GCP project; verify exact model IDs, API surface, region, quotas for Flash-Lite (intake), Flash (coordination/verification), Live (voice). Check Gemini/GenAI clinical-use terms. |
| Repo | Monorepo: `apps/web-api`, `apps/worker`, `apps/voice`; `packages/domain`, `contracts`, `ai`, `adapters`, `observability`; `infra/`, `evals/` (§09). TypeScript, pnpm, lockfile, lint/typecheck, Zod. |
| Infra | Terraform skeleton: Cloud Run ×3, Firestore, private GCS bucket, Cloud Tasks queue, Secret Manager, Artifact Registry. Separate demo/staging and pilot projects. |
| Config | Env inventory from §22 (`APP_ENV`, `*_MODEL_ID`, `BOOKING_ADAPTER=sandbox`, `VOICE_ADAPTER=browser`, `OUTREACH_ENABLED=false`, `MAX_CONTACT_ATTEMPTS=2`, `MAX_CASE_AUDIO_SECONDS=180`). |
| Fixtures | Synthetic demo tenant ("Siliguri Demo Lab"), staff for each role, patients, consents, action tickets, sandbox slots. |

**Exit:** CI green on an empty build; Firestore emulator runs; a model call succeeds with the pinned IDs; fixtures load.

---

## Phase 1 — Domain core (the invariants)
**Goal:** the authoritative workflow, independent of UI and AI. This is what makes the MVP "done" per §22.

- Four-axis state model (§12): `workflowState`, `outreachDisposition`, `handoffState`, `evidenceState`, `bookingState`, `automationPausedReason`.
- Transition guards as pure functions (approve, dispatch, request booking, confirm booking, await evidence, verify, cancel, reopen).
- Tenant-scoped Firestore repositories for the §13 collections; required indexes; cursor pagination.
- Command layer: `expectedVersion` optimistic concurrency → 409; idempotency keys bound to tenant + command + payload hash.
- Append-only `events` written in the same transaction as each transition.
- Transactional outbox written atomically with transitions.
- Approval revision/hash; editing patient, action or due date invalidates approval and pauses automation.
- Duplicate fingerprint (tenant + source authority/ref + obligation key).

**Exit (unit + emulator tests):** no outreach without current approval/consent; no BOOKED without persisted acknowledgment; no COMPLETED_VERIFIED without evidence; concurrent commands conflict instead of overwriting. Covers the domain half of MVP-01, 02, 05, 09, 10.

---

## Phase 2 — Staff app: auth, intake, approval, queue
**Goal:** a staff member can create, review and approve a case and see it in a queue.

- Firebase Auth, invite-only membership, roles: Owner, Reviewer, Coordinator, Verifier, Auditor (§03). Backend checks every command; no browser → Firestore access.
- API: `GET /v1/me`, `GET/POST /v1/cases`, `GET /v1/cases/:id`, `PATCH /v1/cases/:id/draft`, `POST /v1/cases/:id/approve` with the §15 error envelope and HTTP semantics.
- Screens (Next.js + Tailwind/shadcn): Overview work queue (§05), Cases list, Intake review with approval checklist (§07), Case workspace with source/approval, timeline, booking panel, evidence panel, role/state-dependent actions — no "Mark done" button (§06).
- Status by text + icon, never color alone; empty/error/loading states; 5-second polling on the active case.

**Exit:** MVP-01 (create + duplicate warning) and MVP-02 (only reviewer approves; missing fields block) pass end-to-end; cross-tenant IDs return 404.

---

## Phase 3 — Async processing & booking
**Goal:** reliable side effects with reconciliation.

- Outbox dispatcher → deterministically named Cloud Tasks; recovery sweep; authenticated worker handlers; durable `operations`/`jobs` with leases; `failed_jobs` collection with replay preserving operation ID (§16).
- Booking adapter interface + **sandbox** implementation (slot + reservation in one transaction; concurrent requests → one confirmed, one conflict) + **manual** staff-confirmation adapter with badge (§17).
- API: `GET /v1/cases/:id/slots`, `POST /v1/cases/:id/booking-requests`, `POST /v1/bookings/:id/cancel`, `POST /v1/cases/:id/contact-requests`, `GET /v1/operations/:id`.
- Timeout → `bookingState=UNKNOWN`, never blind retry. Out-of-order callbacks cannot resurrect a cancellation.
- Contact-attempt budget (max 2) and audio budget reserved atomically; execution-time recheck of consent, approval revision, contact window, age eligibility.
- Bookings screen.

**Exit:** MVP-03, MVP-04 (only adapter slots), MVP-05, MVP-10 pass; concurrency/failure-recovery tests from §21 pass.

---

## Phase 4 — AI agents & voice
**Goal:** the four bounded agents, each with only its own tools.

| Agent | Model role | Allowed |
|---|---|---|
| Intake | Flash-Lite | Approved text/PDF → fields + source spans + missing flags. No outreach/booking/approval. |
| Conversation | Live | Preferences and barriers; proposes tool calls. Cannot approve, judge urgency or complete. |
| Coordination | Flash | `list_slots`, `request_booking`, `request_callback`, `create_handoff` via command gateway. Max 3 tool ops, 2 replans, time/token budget. |
| Verification | Flash | Read-only evidence extraction + conflict detection; recommendation only. |

- `AgentProposal` schema (§10) validated with Zod; unknown fields rejected; source refs checked; document text treated as data (prompt-injection safe).
- `apps/voice`: `POST /v1/voice/sessions` issues single-use, case-bound ticket; WSS gateway to Live model; no API key in browser; supervised/labeled demo identity step; minimal context; interruption/backpressure; session cap below Cloud Run timeout; disconnect reconciles outstanding operations (§11).
- Conversation script: AI disclosure, human option, identity, logistics, read-back of slot, "request sent" until confirmed. Medical question → stop, site-approved response, staff task (MVP-06).
- Conversation language targets: English, Hindi, Bengali, and Nepali. Each language must pass local-speaker evaluation before activation for patient sessions; unsupported languages require human handoff.
- Record model/prompt versions on every interaction.

**Exit:** demo conversation books a sandbox slot for a "can't come during work hours" patient; medical-advice and invented-slot scenarios behave correctly.

---

## Phase 5 — Evidence, handoff, opt-out, patient page
**Goal:** close the loop and make every exception visible and owned.

- Evidence ingestion: `POST /v1/cases/:id/evidence`, `POST /v1/evidence/:id/attest`, `POST /webhooks/:provider/:account` (signature check on raw payload → durable inbox → async normalize; tenant from account mapping).
- Deterministic matcher (tenant, patient ref, obligation, provider ref, occurrence time); wrong evidence → REJECTED/CONFLICTED with reason; self-report kept separate (§18).
- Verification transaction: evidence + event + case state atomic.
- Handoffs: create, `POST /v1/handoffs/:id/acknowledge`, resolve, overdue + backup notification; Human Queue screen. Acknowledgment does not complete the case (MVP-11).
- Consent: `POST /v1/consents/:id/revoke` → immediate suppression; pending jobs exit; live session ends politely (MVP-07). Admin site-wide "Pause outreach."
- Reopen with reason; history preserved.
- Patient page `/p/:opaque_token`: hashed expiring token, identity gate, no clinical content; actions: request change, request callback, stop automated contact.

**Exit:** MVP-06, 07, 08, 09, 11 pass; mismatched evidence rejected, matching simulated attendance accepted.

---

## Phase 6 — Evaluation, reports & Event MVP release
**Goal:** prove it works, then demo it.

- Eval pack in `evals/`: ≥60 synthetic cases across Hindi/English with fixed expected outcomes — identity mismatch, missing approval, duplicate ticket, no slot, tool timeout, cancellation, opt-out, wrong evidence, unreachable, medical question, document prompt injection.
- Scenario runner reporting per-scenario pass rate, latency, cost, failures, by language.
- Baselines: full multi-agent vs single-model vs rules-plus-reminders. Keep a role only if it measurably helps.
- Reports screen + Overview metrics: contacted, booked, self-reported, verified completion kept separate with cohort/date filters (MVP-12). Scenario economics clearly labeled as illustrative.
- Staging deploy pipeline (§20): typecheck → unit/emulator → build → scan → staging → synthetic smoke.
- Three-minute demo script (Blueprint p.12) + labeled backup recording.

**Release gate (Event MVP):** all P0 acceptance tests pass in staging; zero unauthorized contact, duplicate reservation or false verified completion in the suite; published test report, known limitations, model/prompt versions.

---

## Phase 7 — Pilot hardening (≈2–4 weeks, planning estimate)
**Goal:** safe for real patients at one lab under supervision.

- **Providers:** Exotel AgentStream PSTN adapter (verify transfer/handoff flow, media auth, rates); WhatsApp approved templates + opt-in; real calendar or manual booking flow; identity-verification method agreed with the lab.
- **P1 intake:** PDF intake agent (administrative fields only, source spans, human correction) and CSV bulk import (preview, validation, duplicate warnings, no silent partial import).
- **Security & privacy (§19):** MFA, tenant-isolation tests on every endpoint, file allowlists/malware checks, redacted logs, audio recording off, Secret Manager + least-privilege service accounts, export/deletion workflow, retention defaults, incident runbook.
- **Compliance review:** intended-use review against NMC Telemedicine Guidelines; DPDP notice/consent/withdrawal/grievance processes; Gemini/Google Cloud healthcare and age terms; per-processor data-location check (inference, telephony, messaging, logs, backups).
- **Operations (§20):** monitoring dashboard (outbox age, queue delay, UNKNOWN bookings, unacknowledged handoffs, consent blocks, model errors, voice disconnects, cost/case), named on-call operator, per-tenant budgets + pause switch, backup/restore drill (RPO ≤24h, RTO ≤4h), load test (10 concurrent voice sessions, p95 API <500 ms, Live first response <2 s).
- Bengali and Nepali release only after local-speaker evaluation passes for each language.

**Exit:** pilot project deployed; security/compliance sign-off; restore drill done; `OUTREACH_ENABLED` flipped only with a named lab owner and staffed contact window.

---

## Phase 8 — Supervised pilot & commercial validation
**Goal:** measured evidence, not claims.

- Qualify the site (Blueprint p.3): owner authority, ~200+ eligible cases/month, named staff owner + clinical reviewer, completion evidence source, shared baseline.
- 2 weeks baseline observation → 4 weeks supervised intervention on comparable non-urgent approved tasks; concurrent usual-care comparison where feasible; first live interactions reviewed under protocol.
- Measure: verified completion by due date (primary), ≥60% identity-verified contact, +10 pp vs usual care (exploratory), ≥30% fewer staff minutes per 100 cases, zero false completions/unauthorized contact.
- Meter real cost per case (AI, voice, retries, messages, support) and replace margin scenarios with invoices.
- Validate pricing: INR 2,999/site/month + INR 25/enrolled case, 2 attempts & 3 billed minutes per case.

**Exit:** at least two sites accept paid continuation at an explicit price.

---

## Phase 9 — Later (only after adoption)
LIMS connectors, FHIR interoperability, multi-site controls and analytics, payments, tamper-evident exports/retention locks, LIMS-reseller channel, additional languages and regions.

**Explicitly out of scope until then:** disease-specific pathways, raw-result interpretation, unsupervised critical-result handling, insurance, Kubernetes, vector DB, data warehouse, autonomous agent swarm.

---

## Mapping to the two build days
| Block | Phases |
|---|---|
| Before event | Phase 0 |
| Day 1 morning | Phase 1 + Phase 2 (auth, tenant API, overview/intake/case screens — forms before polish if solo) |
| Day 1 afternoon | Phase 1 approval/state transactions, Phase 3 sandbox booking, Phase 4 first browser Live session + permission gateway |
| Day 2 morning | Phase 5 evidence/handoff/opt-out, Phase 3 outbox path and failure states |
| Day 2 afternoon | Phase 6 scenario replay, metrics, demo + backup recording |
| After event | Phases 7 → 8 → 9 |
