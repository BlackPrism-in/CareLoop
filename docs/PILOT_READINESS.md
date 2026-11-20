# Pilot readiness (Phase 7)

The pilot means real patients, at one lab, supervised (Blueprint p.11). `OUTREACH_ENABLED` stays `false` until **every** row below is closed. Each row has an owner. Engineering can only close some of them.

## Built and tested in Phase 7
| Control | Where | Evidence |
|---|---|---|
| Tenant isolation on every staff endpoint | `apps/web-api/test/isolation.emulator.test.ts` | A fully privileged member of another lab hits all 37 staff routes with lab A ids and valid bodies: nothing read, nothing changed |
| Staff two-step sign-in (TOTP) | `REQUIRE_STAFF_MFA`, mandatory when `APP_ENV=pilot`; enrolment screen; code at sign-in | Config and claim-check tests. **The real TOTP flow needs Identity Platform with TOTP enabled — verify in staging** |
| Contracted monthly limits per lab | `Tenant.limits`, `usage/{YYYY-MM}` counted in the dispatch transaction | Domain suite (memory + Firestore) |
| Retention defaults | Recovery sweep: expired tickets/sessions/links, 30-day operational records | Jobs emulator test. Case, evidence and audit records are untouched |
| Audited case export | `GET /v1/cases/:id/export` (owner, auditor) | API test |
| Patient erasure request | `POST /v1/patients/:id/erasure` (owner). Refused while open; strips identifiers, revokes permission and links | API test |
| CSV bulk intake (P1) | Preview → commit only with zero errors; idempotent per row | Domain + API tests |
| PDF intake (P1) | ≤ 5 MB, ≤ 10 pages, magic-byte check, text extracted in memory, **file not stored** | API test (real PDF) |
| Operations panel + alerts | Settings → Operations; Terraform uptime checks, log-based alerts to `alert_email` | Terraform validate. **Alerts fire only once deployed** |
| Backups | Firestore PITR + daily backups (7 days) | Terraform. **Restore drill not yet run** (RUNBOOK.md) |
| Load baseline | `pnpm --filter @careloop/scripts load` | Local p95 23 ms. **Staging not measured** |
| Incident runbook | RUNBOOK.md | — |

## Decisions and work needed from you or the lab (cannot be engineered away)
| # | Item | Owner | Why it blocks the pilot |
|---|---|---|---|
| 1 | **Identity verification method** for patients (what is asked, by whom, what assurance) | Lab + you | The patient identity step is still a supervised/simulated button. MVP spec §07: "must be agreed before a real pilot" |
| 2 | **Telephony provider** (Exotel AgentStream per blueprint): account, numbers, caller ID, transfer/handoff flow, rates | You | PSTN calling is not built. Live doesn't dial phones. The adapter will be written against the contracted account's actual API |
| 3 | **WhatsApp** provider, approved templates, opt-in wording | You | Patient links and confirmations are not sent today (marked *Simulated — not sent*) |
| 4 | **Calendar integration** or confirmation that the manual adapter is the pilot workflow | Lab | The sandbox calendar is demo-only |
| 5 | **Legal/regulatory review:** intended use vs NMC Telemedicine Guidelines; DPDP notice, consent and withdrawal wording; grievance contact; incident-notification duties | Counsel | Blueprint p.9. "Non-diagnostic" alone is not an exemption |
| 6 | **Google terms** for the chosen API surface (healthcare and age restrictions, data use) and the processor list with data locations. **Live audio is processed in the US/EU, not India** | You + counsel | Blueprint p.8–9; GCP_SETUP.md |
| 7 | **Retention schedule** with the lab (how long case, evidence and audit records are kept) | Lab + counsel | The defaults above are proposals |
| 8 | **Named staff:** pilot owner, clinical reviewer, staffed contact window, backup, on-call operator email | Lab + you | Blueprint p.3, p.9 |
| 9 | **Baseline data** (2 weeks of current process) and a comparison plan | Lab | Phase 8 needs it to measure anything |
| 10 | **Bengali:** local-speaker evaluation. Google lists only `bn-BD` for Live | You | Keep disabled until it passes |

## Engineering left after those decisions
- Exotel and WhatsApp adapters against the contracted APIs, with signed callbacks, through the existing adapter interfaces and webhook inbox.
- The agreed identity method, replacing the supervised button.
- Live-model evaluation (`EVAL_LIVE_MODELS=1 pnpm eval`) and voice latency/accuracy tests in Hindi and English.
- First staging deploy, alert test, and restore drill.
