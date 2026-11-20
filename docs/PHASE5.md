# Phase 5: evidence, handoffs, opt-out, patient page (status)

## Completion evidence (MVP-08, MVP-09)
Every piece of evidence is stored with its source and run through a **deterministic matcher** in the same transaction as the case change:

| Outcome | When | Effect |
|---|---|---|
| Match | Signed provider event; same patient reference, same kind of follow-up, after approval and not in the future, booking reference agrees | **Completed · verified** automatically |
| Review | A staff record that passes those checks | Waits for a **verifier** to attest, citing a source and a reason |
| Conflict | Plausible but a different booking reference | Blocks completion until a verifier resolves it |
| Reject | Wrong patient, wrong follow-up, impossible date, no source | Rejected with the reason shown; the case is never edited to fit |
| Self-report | The patient says it happened | Kept separate; **can never be attested as verified** |

The verification agent (Phase 4) can review a pasted administrative excerpt. Its summary appears as advice next to the record; it never decides.

## Provider webhooks
`POST /webhooks/:provider/:account`:
1. HMAC-SHA256 over `timestamp.rawBody`, with a 5-minute replay window. Secrets come from `WEBHOOK_SIGNING_SECRETS` (Secret Manager in the cloud).
2. The tenant comes from the `provider_accounts/{provider}__{account}` mapping, never from the payload.
3. A durable inbox keyed by the provider event id: duplicates get 200, new events 202.
4. The worker runs the `PROVIDER_EVENT` job:
   - Attendance or collection becomes evidence.
   - A cancellation applies only if it's newer than what we know (`sourceSequence`); a late event can't resurrect a cancelled booking.
   - An unmatched event stays visible as `UNMATCHED`.

**Demo buttons** (synthetic labs only, on the case page): *Mismatched record*, *Different booking* and *Matching attendance*. They send signed sandbox events through this same path.

## Handoffs (MVP-06, MVP-11)
- **Handoff records:** each has an owner, a reason and a response deadline. They are created whenever the case's handoff state opens, whatever caused it: an agent, a callback request, an unreachable patient, staff, or the patient page.
- **Acknowledging:** only the owner can acknowledge, unless a reviewer or owner takes it over. Reassigning resets acknowledgment and notifies the new owner.
- **Resolving:** needs a written result. Neither acknowledging nor resolving completes the follow-up.
- **Notifications:** the owner gets an in-app notification. An **overdue** unacknowledged handoff notifies owners and reviewers **once**, during the site's staffed hours only. This is not emergency cover.
- **Human queue:** lists open and resolved handoffs with overdue and backup status.

## Consent and pausing (MVP-07)
- *Patient withdrew permission* (staff) or *Stop automated calls* (patient):
  - The consent record is revoked first, so every execution-time check (dispatch, booking worker, voice tools) denies contact at once.
  - Every open case using that consent is then marked opted out.
  - Obligations themselves are not cancelled.
- **Owner pause** (Overview): stops automated contact for the lab, with an audited reason. Evidence and staff work continue.
- **Cancel follow-up** (reviewer or owner) and **Reopen** (reviewer, verifier or owner) need reasons, and history is preserved.

## Patient page `/p/:token`
- **Creating a link:** a coordinator creates it from the case page. You get a random token (stored only as a hash) plus a **separate 6-digit code**, both shown once.
  - In a synthetic lab nothing is sent.
  - In a pilot, the link and the code go by separate approved messages.
- **Identity gate:**
  - The link alone shows nothing.
  - The code opens a 15-minute `HttpOnly`, `SameSite=Strict` session.
  - Five wrong codes lock the link, and links expire after 7 days.
- **What the patient sees:** the lab name, the kind of follow-up, the appointment or request status, and whether the lab will call. Never their name, the instruction text, contact details or any report.
- **Actions:**
  - *Ask for a different time* and *Ask the lab to call me* create a staff task and **don't** cancel the appointment.
  - *Stop automated calls* withdraws consent after a confirmation step.
- Bilingual (English and Hindi), with large tap targets.

## Tests
- Domain: matcher unit tests (12) and the command suite on memory and Firestore (34 on the emulator). Covers evidence match, reject, conflict and resolution; staff record plus attestation; self-report; handoff records, ownership and reassignment; callback creating a handoff.
- Jobs emulator (20 including Phase 3), covering:
  - bad signature, stale timestamp and unknown account
  - matching event completes once, duplicate delivery ignored
  - mismatched then matching record; stale out-of-order event
  - unmatched event; passed appointment moves to awaiting proof
  - overdue handoff escalates once, in staffed hours only
  - booking worker re-checks consent
- API emulator (20), covering:
  - evidence roles; self-report can't be verified
  - webhook signature and tenant mapping
  - consent revocation suppressing contact; owner-only pause
  - patient link: gate, no private data, actions, lockout, and no access to staff routes
  - handoff ownership and reassignment
- **Checked in the browser** (production build + worker + emulators):
  - booked case → *Mismatched record* rejected ("Different patient reference") → *Matching attendance* → **Completed · verified**, with both records visible and labelled simulated
  - patient link → code → status page → *Ask the lab to call me* → task appears in the Human queue for the owner

## Fix found during the browser check
Shell-sourcing `.env.example` stripped the quotes inside the JSON secret. The value is now single-quoted, which works for `sh`, Node `--env-file` and Next.js.
