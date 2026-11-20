# CareLoop operations runbook (pilot)

**Owner:** the named on-call operator (`alert_email` in Terraform). Alerts never go to an unmonitored inbox.

## Daily checks (lab owner, Settings → Operations)
| Signal | Normal | If not |
|---|---|---|
| Oldest queued work | < 5 min | Check the worker service is up; the recovery sweep runs every minute |
| Failed background jobs | 0 | Open each one. Fix the cause, then **Replay** (owner); replays keep the original operation id |
| Bookings with unknown outcome | 0 | Check the calendar/provider. Reconciliation retries automatically; if it fails 3 times it appears under failed jobs |
| Handoffs overdue | 0 | Backups are notified once in staffed hours. Reassign from the Human queue |
| Calls failed to connect / dropped | low | Check Gemini status and quota (`pnpm check:models`) |
| Calls flagged for review | 0 | Review the case timeline. The agent implied a booking before the calendar confirmed. Report the prompt version |

## Incident procedure (MVP spec §19)
1. **Stop contact:** Overview → **Pause automated contact** (owner, with a reason). This blocks dispatch at execution time. Evidence ingestion and staff work continue.
2. **Preserve evidence:** don't delete anything. Export affected cases (case page → **Export (audited)**), and note the time window and correlation ids from the logs.
3. **Reconcile bookings:** Bookings → *Needs attention*. Resolve UNKNOWN and pending cancellations with the provider before telling any patient anything.
4. **Notify:**
   - Notify the lab owner and the accountable staff.
   - Escalate to vendors as needed (Google Cloud, telephony, messaging).
   - Make any legally required notifications. Who does what must be agreed **before** the pilot (see PILOT_READINESS.md).
5. **Patient contact:** only staff contact patients during an incident, using the approved script.
6. **Resume:** after the cause is fixed and `pnpm eval` passes on the fix, resume contact with a reason, then watch Operations for an hour.

## Restore drill (target RPO ≤ 24 h, RTO ≤ 4 h)
Firestore has point-in-time recovery (7 days) and daily backups (7 days) via Terraform. **Run this drill before the pilot and quarterly.** Never restore over the live database.

List the available backups:

```bash
gcloud firestore backups list --location=asia-south1 --project=<PROJECT_ID>
```

Restore into a **new** database:

```bash
gcloud firestore databases restore --source-backup=<BACKUP_NAME> --destination-database=restore-drill --project=<PROJECT_ID>
```

Then:
1. Point a staging copy of the web app at `restore-drill` (`FIRESTORE_DATABASE_ID`, a pilot follow-up), or inspect it in the console.
2. Check that recent cases, events and evidence are present.
3. Record the time taken and the newest restored write.
4. Delete the drill database:

```bash
gcloud firestore databases delete --database=restore-drill --project=<PROJECT_ID>
```

Record the drill date, duration and data age in the pilot log.

## Rollback
Cloud Run → service → **Revisions** → route 100% to the previous revision (images are deployed by digest). If config changed, revert the Terraform change too. Model or prompt changes roll back with the code, because versions are pinned in the repository.

## Load check (before the pilot and after major changes)
Use a synthetic staff token:

```bash
WEB_URL=<staging url> LOAD_TOKEN=<token> LOAD_CASE_ID=<case> LOAD_CONCURRENCY=10 LOAD_SECONDS=60 pnpm --filter @careloop/scripts load
```

Target: p95 < 500 ms with 0 errors. The local emulator baseline (20 Nov 2026) was p95 23 ms at 10 concurrent users. That's not a production number. Voice target: 10 concurrent sessions with first response p95 < 2 s, measured on the real Live model.
