# Phase 1 — Domain core: status

All case state changes go through `CaseCommands` in [packages/domain](../packages/domain/src). Nothing else writes cases.

## How a command runs
One Firestore transaction per command:
1. **Permission check** from `ActorContext` (built server-side; tenant and actor never come from the request body).
2. **Idempotency:** `operationId = sha256(tenant, command, key)`. The same key with the same payload replays the stored result. The same key with a different payload returns `409 IDEMPOTENCY_KEY_REUSED`.
3. **Load and version check:** a stale `expectedVersion` returns `409 VERSION_CONFLICT`. Cross-tenant references return `404`.
4. **Pure guard** in [transitions.ts](../packages/domain/src/transitions.ts) decides the patch or throws `422` with a stable reason code.
5. **Atomic write:** case (`version + 1`), an append-only event `{caseId}-v{version}`, outbox items for later side effects, and the operation record.

No provider or model calls happen inside the transaction. They go through the outbox (Phase 3).

## Rules enforced and tested
| Rule | Where |
|---|---|
| No outreach without a current approval, active consent for the channel, adult eligibility, contact window, kill switch, site pause, attempt and audio budgets (re-checked at execution time) | `dispatchContact` |
| Only REVIEWER approves; the checklist must be complete; editing patient, action, deadline, site, source or consent invalidates approval | `approve`, `editDraft`, `approvalHash` |
| BOOKED only with a reservation reference; UNKNOWN blocks a new booking until reconciled | `confirmBooking`, `markBookingUnknown`, `requestBooking` |
| Completion only via a matcher's trusted event (SYSTEM) or a VERIFIER attestation with source and reason, after approval, not in the future, no open conflict | `verifyCompletion` |
| Self-report, handoff acknowledgment and booking never complete a case | `recordSelfReport`, `acknowledgeHandoff`, `confirmBooking` |
| Opt-out suppresses contact immediately but doesn't cancel the obligation | `optOut` |
| AUDITOR has no writes; agents never approve, cancel, verify, reopen or acknowledge | `PERMISSIONS` |
| Duplicate source + obligation returns the existing case with `DUPLICATE_SOURCE_ACTION` | `createCase` + `case_fingerprints` |

## Tests
Run the unit tests and the in-memory store suite (35 tests):

```bash
pnpm test
```

Run the same 26-test command suite against the Firestore emulator (needs Java and the Firebase CLI):

```bash
pnpm test:emulator
```

## Left for later phases
- HTTP routes and Firebase Auth → membership → `ActorContext` (Phase 2).
- Outbox dispatcher, recovery sweep, Cloud Tasks, booking adapters (Phase 3).
- Evidence matching, handoff documents with owners/backups, patient links (Phase 5).
