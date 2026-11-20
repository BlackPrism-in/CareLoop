# Phase 2: staff app (status)

## Run it locally

Start the emulators and leave them running:

```bash
pnpm emulators
```

In a second terminal, seed the synthetic lab and staff logins. Use your `.env.local`, or `.env.example` until you have one:

```bash
set -a && . ./.env.example && set +a && pnpm seed
```

Then start the web app:

```bash
set -a && . ./.env.example && set +a && pnpm --filter @careloop/web-api dev
```

Open http://localhost:3000 and sign in as any seeded staff member:
- `reviewer@demo.careloop.test` (reviewer)
- `frontdesk@demo.careloop.test` (coordinator)
- `verifier@demo.careloop.test` (verifier)
- `owner@demo.careloop.test` (owner)
- `auditor@demo.careloop.test` (auditor)

All of them use the test-only `DEMO_STAFF_PASSWORD` from `.env.example`. These accounts exist only in the Auth emulator.

## How auth works
1. The browser signs in with Firebase Auth and sends `Authorization: Bearer <ID token>`.
2. The API verifies the token (including revocation) and reads the tenant from a **server-set custom claim** (`tenantId`).
3. On every request it loads `tenants/{tenantId}/members/{uid}`. A suspended or revoked membership gets 403 immediately. Roles come from membership, not the token.
4. The resulting `ActorContext` is the only identity the domain sees. Request bodies can't carry `tenantId` (strict schemas reject it).

## API (MVP spec §15)
| Route | Notes |
|---|---|
| `GET /v1/me` | Membership, roles, lab |
| `GET /v1/overview` | Counts via aggregation queries |
| `GET /v1/lookups` | Patient aliases, consents, staff, sites for the New follow-up form |
| `GET /v1/cases` | Filters `workflowState`, `owner=me`, `view=handoffs\|proof`; cursor pagination |
| `POST /v1/cases` | Needs `Idempotency-Key`; 201 for a new case, 200 + `DUPLICATE_SOURCE_ACTION` for a duplicate |
| `GET /v1/cases/:id` | Case, source, consent status, masked contact, timeline with actor names. Another lab's id returns 404 |
| `PATCH /v1/cases/:id/draft` | `expectedVersion`; material edits invalidate approval |
| `POST /v1/cases/:id/approve` | Reviewer only; full checklist and source authority reference |

## Screens
Sign-in, Overview (counts + my/all queue), Cases (filters), Intake review (checklist with values beside their sources; Approve stays disabled until everything is confirmed), Case workspace (approval, booking, evidence, timeline, 5-second polling, edit draft), New follow-up, Human queue. Bookings, Reports and Settings are placeholders for later phases.

## Tests
- `pnpm test`: unit tests and the in-memory domain suite.
- `pnpm test:emulator`: domain suite (26) and API suite (11) on the emulators. The API suite covers 401/403 envelopes, suspended members, MVP-01 (create, replay, duplicate, `tenantId` rejected), MVP-02 (role, checklist, approve), 409 version conflict, approval invalidation, cross-tenant 404, and pagination.
- Checked in the browser: sign-in → overview → intake review → approve → edit invalidates approval, at desktop and phone width. No console errors.
