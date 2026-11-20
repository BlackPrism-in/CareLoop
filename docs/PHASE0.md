# Phase 0 — Foundations: status and open decisions

See [ROADMAP.md](ROADMAP.md) for the full plan.

## What is in the repo

| Path | Contents |
|---|---|
| `packages/contracts` | Zod schemas: the 4-axis state model + booking/pause axes, staff roles, error envelope + HTTP mapping, event envelope, normalized provider event, strict `AgentProposal`, app config (outreach refuses to enable outside `pilot`), Phase 0 record shapes, fixture bundle with referential checks. |
| `packages/domain` | Tenant-scoped Firestore path helpers (reject unsafe ids), duplicate fingerprint. Phase 1 adds guards, commands, repositories, idempotency, outbox. |
| `packages/adapters` | Interfaces for booking (incl. `UNKNOWN` / `PENDING_STAFF` results), messaging, identity, evidence webhooks. No implementations yet. |
| `packages/ai` | Role → model ID mapping, Google Gen AI client factory (Vertex or Developer API). |
| `packages/observability` | JSON logger for Cloud Logging with recursive PII/secret redaction, correlation IDs. |
| `apps/web-api` | Next.js 16 + Tailwind 4 shell, `/api/health`, `/v1/me` stub returning the error envelope. |
| `apps/worker` | Hono service: `/healthz`, `/tasks/:kind` allow-list returning 501 until Phase 3. |
| `apps/voice` | HTTP + WebSocket server: `/healthz`; refuses all upgrades until Phase 4. |
| `scripts` | `pnpm seed` (emulator-only, `demo-*` projects only), `pnpm check:models`. |
| `evals/fixtures/demo-tenant.json` | Synthetic "Siliguri Demo Lab": 1 site, 5 staff (one per role), 4 patients (one with revoked consent, one with unknown age eligibility), 4 DRAFT cases, 5 sandbox slots. |
| `infra/` | Terraform: APIs, Artifact Registry, Firestore (PITR), private source bucket (7-day lifecycle), Cloud Tasks queue (3 infra retries), Secret Manager containers, per-service service accounts, 3 Cloud Run services. Deny-all Firestore rules + §13 indexes. |
| `.github/workflows/ci.yml` | format → typecheck → test → build; Terraform fmt/validate. |

## Local quick start

```bash
pnpm install
```

```bash
cp .env.example .env.local
```

```bash
pnpm emulators
```

In a second terminal:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm seed
```

```bash
pnpm dev
```

Web on :3000, worker on :8081, voice on :8082. Emulator UI on :4000.

```bash
pnpm check
```

## Decisions only you can close (Phase 0 exit)

| # | Decision | Status | Where |
|---|---|---|---|
| 1 | **Google Cloud account and projects.** Set up from scratch on the Developer Program account that holds the credits. | You: in progress | [GCP_SETUP.md](GCP_SETUP.md) steps 1–4, 6 |
| 2 | **Model IDs.** Names checked against Google's model pages on 20 Nov 2026: `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.8-live` (all stable). Live and 3.8 Flash are not offered in Mumbai, so the config uses `global` for text and `us-central1` for Live. | You: add values to `.env.local`, then run `pnpm check:models` | [GCP_SETUP.md](GCP_SETUP.md) step 5 |
| 3 | **Organizer confirmation and reuse disclosure.** | You: record the reply | [ORGANIZER_DISCLOSURE.md](ORGANIZER_DISCLOSURE.md) |
| 4 | **API surface.** Vertex (recommended) or Gemini Developer API, depending on where the credit applies. Their terms differ on clinical use (Blueprint S11/S12). | Decided with step 1 | `GOOGLE_API_SURFACE` in `.env.local` |
| 5 | **Staff test accounts.** | Phase 2 | — |

## Exit criteria

- [x] Workspace typechecks, tests pass, apps build (`pnpm check && pnpm build`).
- [x] Synthetic fixtures validate (schema, references, fingerprints, every role present).
- [x] Firestore emulator starts and `pnpm seed` loads the tenant. Non-demo projects are refused, and unauthenticated client reads get 403 under the deny-all rules.
- [ ] `pnpm check:models` succeeds with pinned IDs (decisions 1, 2 and 4).
- [ ] Organizer confirmation on file (decision 3).
- [x] `terraform fmt` + `validate` pass locally (Terraform 1.17).
- [ ] `terraform apply` to the demo project (decision 1).
