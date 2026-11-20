# What's left: checklist

**As of 21 Nov 2026.** All code for Phases 0–9 is built, tested and on `main`.
The **demo environment is live** on Cloud Run in project `careloop-demo-2611`
(billed to the "GDP Event Credit: Buildathon day 2" account), with the
synthetic lab only. Real Gemini models pass `check:models` and the live eval.

- Staff app: https://careloop-web-api-94524397144.asia-south1.run.app (use this URL; the other Cloud Run URL fails the voice origin check)
- Staff logins: the five `@demo.careloop.test` addresses; the shared password is in `.env.staging.local` (git-ignored)
- Redeploy: `scripts/deploy-direct.sh careloop-demo-2611` (see [DEPLOY.md](DEPLOY.md))

Owner key: **You** = you, **Lab** = the pilot lab, **Eng** = code work
(Claude can do it), **Counsel** = legal review.

On this machine: `.env.local` and `infra/envs/demo.tfvars` exist (git-ignored), and `gcloud` points at `careloop-demo-2611`.
The Firebase CLI is signed in to a different account, so the deploy script uses the gcloud login instead. The `gh` CLI is not installed.

---

## 1. Before the regional showcase (23 / 25 / 27 Nov)
Goal: a reliable demo on synthetic data. Staging is optional for this.

- [ ] **You:** fill in [ORGANIZER_DISCLOSURE.md](ORGANIZER_DISCLOSURE.md) (organizer reply and prebuilt commits). It still has 10 placeholders.
- [x] **You:** confirm the Developer Program credits and their eligible services ([GCP_SETUP.md](GCP_SETUP.md) step 1).
- [x] Done: `careloop-demo-2611` created (`careloop-demo` was taken). Create the `careloop-demo` project, link billing, enable Vertex AI (GCP_SETUP steps 2–3). Then switch `gcloud` to it:

  ```bash
  gcloud config set project <PROJECT_ID>
  ```

- [x] **You:** `cp .env.example .env.local` and fill in the project and model IDs (GCP_SETUP step 5).
- [x] **You:** `pnpm check:models`: all four rows `OK`.
- [x] **You + Eng:** `EVAL_LIVE_MODELS=1 pnpm eval`: 64/64 pass. Coordination 12/12 with Gemini (rules alone 10/12), about 5–6 s each. Intake 10/10 fields; Flash-Lite took 1.4 s.
- [ ] **You:** try one real browser voice call in Hindi and one in English on the emulator demo. Note latency and any script slips.
- [ ] **You:** rehearse [DEMO.md](DEMO.md) end to end on the production build, including `demo-reset` between runs.
- [ ] **You:** have a fallback ready: a screen recording of the full demo in case venue Wi-Fi or the Live API fails.

## 2. Deploy staging (needed before any pilot; nice for the finale, 2 Dec)
Follow [GCP_SETUP.md](GCP_SETUP.md) step 6, then [DEPLOY.md](DEPLOY.md).

**Google Cloud and Firebase (You)**
- [x] Add Firebase to the project and enable Email/Password sign-in.
- [x] For MFA testing: upgrade to Identity Platform and enable TOTP.
- [x] Create the Terraform state bucket (with versioning).
- [x] Copy `infra/envs/demo.tfvars.example` to `demo.tfvars`. Fill in the project ID, model IDs and `alert_email`. Keep `outreach_enabled = false`.
- [x] Run `terraform init` and `terraform apply`. Note the URLs from `terraform output urls`.

**GitHub deploy access (You). Optional now: `scripts/deploy-direct.sh` deploys from this laptop**
- [ ] Create a Workload Identity pool and provider limited to `BlackPrism-in/CareLoop` (commands in DEPLOY.md).
- [ ] Create the `careloop-deploy` service account with the five roles in DEPLOY.md, and allow WIF to impersonate it.
- [ ] Create the GitHub environment `staging` with these variables: `STAGING_GCP_PROJECT`, `STAGING_REGION`, `STAGING_WIF_PROVIDER`, `STAGING_DEPLOY_SA`, `STAGING_WEB_URL`, `STAGING_VOICE_URL`, `STAGING_FIREBASE_WEB_API_KEY`.
- [ ] Add the GitHub secrets `STAGING_SMOKE_STAFF_EMAIL` and `STAGING_SMOKE_STAFF_PASSWORD`, for a synthetic staff account.

**Secrets and data (You)**
- [x] Secret Manager `webhook-signing-secrets`: `{"sandbox:<account>":"<random 32+ chars>"}`. Add `"lims:<account>"` too if you'll test a LIMS feed.
- [x] Firestore `provider_accounts/sandbox__<account>` mapping document (and `lims__<account>` if needed, see [PHASE9.md](PHASE9.md)).

**Code still needed for staging (Eng)**
- [x] **Staging bootstrap script** (`pnpm --filter @careloop/scripts bootstrap:staging`): creates the first lab, sites, owner/staff memberships and Auth users in a real project. Today `seed` and `demo-reset` deliberately work only on the emulators, so a fresh staging project has no lab and no one can sign in.

**First deploy and checks (You + Eng)**
- [x] First deploy done with `scripts/deploy-direct.sh` (Cloud Build, deploy by digest, rules and indexes, smoke test). The GitHub `deploy-staging` workflow still needs the setup above. It builds, Trivy-scans, deploys by digest, deploys rules and indexes, and runs the smoke test.
- [x] Firestore indexes are all READY (25). Case list, lookups, sites, reports and billing respond for the owner; the reviewer is correctly refused billing.
- [ ] Check that staff TOTP sign-in works end to end.
- [ ] Load test against staging with `pnpm --filter @careloop/scripts load`, and record p95.
- [ ] Trigger a test alert and confirm it reaches `alert_email`.
- [ ] Run a backup **restore drill** ([RUNBOOK.md](RUNBOOK.md)) and record the time taken.

## 3. Before real patients (pilot): blockers from [PILOT_READINESS.md](PILOT_READINESS.md)
`OUTREACH_ENABLED` stays `false` until every row is ticked.

**Decisions (cannot be coded around)**
- [ ] **Lab + You:** patient identity verification method. Today it's a supervised button.
- [ ] **You:** telephony provider (Exotel AgentStream): account, numbers, caller ID, rates.
- [ ] **You:** WhatsApp provider, approved templates and opt-in wording.
- [ ] **Lab:** calendar integration, or confirm manual booking for the pilot.
- [ ] **Counsel:**
  - NMC telemedicine fit
  - DPDP notice, consent and withdrawal wording
  - grievance contact
  - incident-notification duties
- [ ] **You + Counsel:** Google terms for the API in use, plus a processor list with data locations. Live audio is processed in the US/EU, not India.
- [ ] **Lab + Counsel:** retention schedule (the current values are proposals).
- [ ] **Lab + You:** named people: pilot owner, clinical reviewer, staffed contact window, backup, on-call email.
- [ ] **Lab:** 2 weeks of baseline data and the comparison plan ([PILOT_PROTOCOL.md](PILOT_PROTOCOL.md)).
- [ ] **You:** separate `careloop-pilot` project (`pilot.tfvars`, `app_env = "pilot"`), so MFA is forced on.

**Code that follows those decisions (Eng)**
- [ ] Exotel calling adapter (signed callbacks via the existing webhook inbox).
- [ ] WhatsApp adapter for patient links and confirmations (today: "Simulated — not sent").
- [ ] The agreed identity check, replacing the supervised button.
- [ ] Calendar adapter, if the lab has one.
- [ ] Hindi and English voice quality tests: accents, interruptions, latency (p95 < 2 s target), script adherence.

## 4. Later (Phase 9 follow-ups, need a real partner)
- [ ] **You:** Bengali: local-speaker evaluation (Google lists only `bn-BD`). Then **Eng:** Bengali eval scenarios. Then set `enabled_languages` to include `bn-IN`.
- [ ] **Eng:** check the HL7 parser against a real LIMS vendor sample (identifiers removed).
- [ ] **You:** FHIR identifier systems and profiles from the receiving hospital (for example ABDM); then **Eng** replaces the placeholder URIs.
- [ ] **You:** billing rules: a site added mid-month, reseller margin, who invoices the lab. GST tax invoices stay outside CareLoop.
- [ ] **Lab:** decide whether patients and consents should be per-site (today they're lab-wide).
- [ ] **You:** partner agreement terms ([PARTNER_GUIDE.md](PARTNER_GUIDE.md) placeholders).

## Quick re-check before any release
```bash
pnpm check && pnpm test:emulator && pnpm eval && pnpm build && ./scripts/check-bundles.sh
```
