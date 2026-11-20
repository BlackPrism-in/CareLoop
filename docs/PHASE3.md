# Phase 3: background jobs and booking (status)

## How side effects run
1. A command (for example `requestBooking`) writes the case change, its event and an **outbox** item in one transaction.
2. The API "kicks" the **dispatcher** for that case. It leases the outbox item, creates a queue task named after the item (so duplicates are rejected), then marks it DISPATCHED. If the API crashes, the **recovery sweep** finds the PENDING item (Cloud Scheduler every minute in the cloud; every 10 s in the local worker).
3. The **worker** claims a durable job record with a 60 s lease, runs the handler, stores the result, and only then returns 200:
   - A repeat delivery of a finished job returns the stored result.
   - A delivery during a live lease returns 409 so the queue retries later.
   - Transient errors return 503. After 3 attempts the job lands in `failed_jobs` and shows on **Settings → Failed background jobs**, where an owner can replay it with the same operation id.
4. Handlers re-check the case at execution time (approval, opt-out, state) and change it only through domain commands with per-job idempotency keys.

## Booking (MVP spec §17)
| Outcome from the adapter | What happens |
|---|---|
| Confirmed | Booking record saved, then `confirmBooking` → BOOKED |
| Slot taken / incompatible | `recordBookingRejected` → back to scheduling |
| Timeout, error, lost acknowledgment | `markBookingUnknown` → UNKNOWN, automation paused, reconcile job. Never a blind retry |
| Reconcile finds it | BOOKED (same reservation, not a second one) |
| Reconcile finds nothing | Back to scheduling |
| Manual adapter | Staff booking task on **Bookings**; a coordinator enters the clinic's reference and time |
| Cancellation | Stays confirmed until the adapter acknowledges, then the slot is released |
| Case cancelled with a live booking | Reservation released |

- **Sandbox adapter:** a real transactional calendar over `slots` + `sandbox_reservations`. All its results are labelled simulated. Fault injection: `TIMEOUT_AFTER_COMMIT` / `TIMEOUT_BEFORE_COMMIT`.
- **Slot rule:** booking requests are only accepted for slots the adapter is currently offering, and only with the patient's explicit confirmation of the read-back.

## Synthetic contact
`OUTREACH_ENABLED` stays false outside a pilot. A **synthetic** lab may still start a simulated browser-voice contact, because that reaches no real person. Every other channel, and every real lab, is blocked by the kill switch. In this phase a coordinator records the patient's request after contact. The voice agent comes in Phase 4.

## New API
`POST /v1/cases/:id/contact-requests` · `POST /v1/cases/:id/patient-requests` · `GET /v1/cases/:id/slots` · `POST /v1/cases/:id/booking-requests` (202) · `GET /v1/bookings` · `POST /v1/bookings/:id/cancel` (202) · `POST /v1/bookings/:id/confirm-manual` · `GET /v1/operations/:id` · `GET /v1/jobs/failed` · `POST /v1/jobs/:id/replay` (owner only)

## Running locally
Start the emulators and seed as in [PHASE2.md](PHASE2.md). The seed shifts slot dates so the first one is tomorrow. Then run the worker and the web app, each with the env loaded (`set -a && . ./.env.example && set +a`):

```bash
pnpm --filter @careloop/worker dev
```

```bash
pnpm --filter @careloop/web-api dev
```

**Note:** on this Mac, something outside the repo keeps touching files under `node_modules` (likely a sync or indexing service, since the repo is on `~/Desktop`). That makes `next dev` reload in a loop and `tsx watch` restart. Workarounds:
- Move the repo off `~/Desktop`, or exclude it from that service.
- For demos, use a production build: `pnpm --filter @careloop/web-api build && pnpm --filter @careloop/web-api start`.
- The worker's `dev` no longer watches files; `dev:watch` does.

## Tests
- `packages/jobs` (12, emulator), covering:
  - booking happy path; duplicate dispatch and delivery
  - crash before task creation (sweep); live lease defers, then runs once
  - provider succeeds then times out → reconcile finds the same booking; timeout before commit → nothing reserved
  - two cases racing for the last place; opt-out after the request
  - retries → failed job → replay with the same operation id
  - cancellation releases the slot; case cancellation releases the slot; manual adapter
- `apps/web-api` (13, emulator): the routes above, including an invented slot (422), a missing patient confirmation (400), operation status, a cross-lab 404 and owner-only replay.
- Domain: rejection and cancellation transitions, a late "confirmed" that can't resurrect a cancellation, the kill switch versus synthetic contact.
- Checked in the browser (production build + worker): start contact → patient wants to book → pick an adapter slot with read-back confirmation → worker reserves → BOOKED with a sandbox reference → cancel → provider acknowledges → slot offered again.
