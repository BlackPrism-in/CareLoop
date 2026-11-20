# Phase 9: multi-site, integrations, billing, Bengali (status)

The roadmap puts Phase 9 after adoption. It was built early, against generic
assumptions, so each section ends with what a real partner still has to
confirm. Expect rework once a hospital, LIMS vendor or reseller is signed.

## Multi-site labs
- A lab (tenant) can have several **sites**. Owners and auditors see every site. Every other staff member sees and changes only cases at the sites listed in their membership (`permittedSiteIds`).
- A case at another site is treated exactly like a missing case (404), on every route: case pages, lists, bookings, handoffs, evidence, reviews, failed jobs, time logs, operations, exports, reports and consent withdrawal.
- **Settings → Sites and staff access** (owner only): add or edit a site (time zone, calling hours) and tick which sites each staff member works at. Changes apply on that person's next request and are written to the audit log.
- API: `GET/POST /v1/sites`, `GET /v1/members`, `POST /v1/members/:id/sites`.
- Firestore indexes with `siteId` first were added for the case list filters (`infra/firestore.indexes.json`).
- Tested by the isolation sweep: a same-lab staff member limited to another site calls every route against a case at the first site. Every route must refuse or show nothing from that case, and the data must be unchanged.

**Still to confirm:** whether patients and consents should also be per-site. Today they belong to the lab, so a site-limited coordinator can see patient aliases from other sites in pickers.

## Tamper-evident case history
- Every case event stores `prevHash` (the previous event's hash) and `hash` (sha256 of its canonical JSON). The case stores the newest hash as `lastEventHash`.
- `GET /v1/cases/:id/integrity` (owner, auditor) re-checks the chain and returns the head hash. The case export includes the same check.
- It detects edited, deleted, inserted and reordered events. It **cannot** detect someone with database write access who rewrites the whole chain *and* the head. To cover that, record head hashes outside CareLoop, for example in a monthly signed export.
- Events written before this change have no hash; they are reported as `unchained` and are not covered.

## FHIR R4 export
- Case page → **FHIR R4** (owner, auditor; audited), or `GET /v1/cases/:id/export?format=fhir`.
- A `collection` Bundle containing:
  - **Patient**: identifiers only (CareLoop id and the lab reference). No name, phone or birth date.
  - **ServiceRequest**: the ordered consultation or test and its due date.
  - **Task**: CareLoop's coordination, with status from the workflow.
  - **Appointment**: confirmed or cancelled bookings.
  - **Provenance**: who changed the case, plus the event-chain head hash and whether it verified.
- Synthetic data is tagged `simulation`.

**Still to confirm:** the receiving system's identifier systems and required profiles (for example ABDM/NRCeS profiles in India). The URIs under `https://careloop.example/fhir` are placeholders until then.

## LIMS / hospital order intake
`POST /webhooks/lims/:account` accepts one order per request, as either:
- **JSON** (`application/json`): `orderId`, `patientRef`, `actionType` (`CONSULTATION` or `ORDERED_TEST`), `actionText`, `due` (YYYY-MM-DD or ISO time), `orderingAuthority`. Unknown fields are refused, including any `tenantId`.
- **HL7 v2 ORM^O01** (`x-application/hl7-v2+er7`, or any body starting with `MSH`). Reads PID-3, ORC-1/2/12, OBR-2/4/7/16/27 and TQ1-7. Only new orders (`ORC-1 = NW`) are accepted; cancels and changes are refused for staff to handle.

Rules:
1. Signed like provider webhooks: header `x-careloop-signature: t=<unix>,v1=<hmac>`, HMAC-SHA256 over `<t>.<raw body>`, 5-minute window.
2. The tenant, site and default owner come from `provider_accounts/lims__<account>`, never the message.
3. A matched order becomes a **DRAFT** case owned by the default owner. A reviewer must still approve it before any contact.
4. Each order is stored once in `lims_inbox`; repeats return 200 `DUPLICATE`.
5. Unknown patient, more than one matching patient, or no active consent: the order is held as `NEEDS_REVIEW` (202). Staff can list held orders at `GET /v1/intake/lims`.
6. Responses never echo patient data.

### Connecting a feed (owner + platform operator)
1. Choose an account name, for example `cityhospital`.
2. Add a secret to Secret Manager `webhook-signing-secrets` (JSON): `"lims:cityhospital": "<long random secret>"`. Share it with the sender over a secure channel.
3. Create the Firestore document `provider_accounts/lims__cityhospital`:
   `{ "tenantId": "<lab tenant>", "siteId": "<site>", "defaultOwnerId": "<staff uid>", "active": true }`
4. Give the sender the URL `https://<web host>/webhooks/lims/cityhospital`.
5. Send a test order for a synthetic patient and check it appears as a draft.

**Still to confirm:** the vendor's real message profile (segments, coding systems, MLLP-to-HTTPS gateway), and whether orders should match patients by something stronger than the lab reference.

## Billing
- **Settings → Billing** (owner): issue the statement for a finished month and download it as CSV. API: `GET/POST /v1/billing/statements`, `GET /v1/billing/statements/:month?format=csv`.
- Price: ₹2,999 per site per month plus ₹25 per enrolled follow-up. If the pilot config sets prices, those are used.
- A follow-up is charged **once**, in the first statement after a reviewer approves it. Drafts, cases cancelled before approval, and baseline or usual-care pilot cases are never charged.
- Months are issued in order and only after they end, using India-time month boundaries. Issuing the same month again returns the same statement.
- This is a usage statement, not a GST tax invoice. The lab's accounting system issues the tax invoice with GSTIN and SAC codes. No payment is collected in CareLoop.

**Still to confirm:** whether a site added mid-month is charged a full month, and the reseller's share (see [PARTNER_GUIDE.md](PARTNER_GUIDE.md)).

## Bengali (off by default)
- `ENABLED_LANGUAGES` (default `hi-IN,en-IN`; Terraform variable `enabled_languages`). Adding `bn-IN` enables:
  - Bengali in the new-case form and CSV import
  - the Bengali call prompt
  - English plus Bengali on the patient page
  - Bengali words in the medical-question and premature "booked" detectors
- A language that isn't enabled is refused when a case is created or edited, and new contact stops for existing cases in that language.
- Google's Gemini Live language list names Bengali (Bangladesh), `bn-BD`, not `bn-IN`. Run supervised test calls with native speakers before enabling it.
- The 64 eval scenarios are still Hindi and English. Add Bengali scenarios before a Bengali pilot.

## Per-site analytics
- **Reports** has a site filter and a **By site** table: approved, window closed, verified on time (with rate), open handoffs and opt-outs. The definitions are the same as the headline rate.
- Small sites give unstable percentages; read the counts alongside the rates.
