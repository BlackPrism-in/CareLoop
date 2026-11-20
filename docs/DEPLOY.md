# Deploying to staging

## Pipeline (`.github/workflows/deploy-staging.yml`)
After `ci` passes on `main` (or on manual dispatch), the pipeline:
1. Builds the three images. The web image gets the public Firebase browser config as build arguments.
2. Scans them with Trivy and fails on fixable HIGH/CRITICAL findings.
3. Pushes and deploys each Cloud Run service **by digest**.
4. Deploys the Firestore rules and indexes.
5. Runs `pnpm --filter @careloop/scripts smoke` against staging.

It is a no-op until `STAGING_GCP_PROJECT` is set, and it never touches the pilot project.

`ci` already does the following on every push:
- Boots the production builds (`scripts/check-bundles.sh`); this caught a bundling crash that would have shipped.
- Runs every emulator suite and the 64-scenario release gate (`pnpm eval`), and uploads the report.

## One-time setup (after `terraform apply` for staging, see GCP_SETUP.md)
1. **Workload Identity Federation for GitHub:** there are no service-account keys. Create a pool and a provider restricted to this repository:

   ```bash
   gcloud iam workload-identity-pools create github --location=global --project=<PROJECT_ID>
   ```

   ```bash
   gcloud iam workload-identity-pools providers create-oidc careloop --location=global --workload-identity-pool=github --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository --attribute-condition="assertion.repository=='BlackPrism-in/CareLoop'" --project=<PROJECT_ID>
   ```

2. **Deploy service account** `careloop-deploy`, with these roles:
   - `roles/run.admin`
   - `roles/artifactregistry.writer`
   - `roles/iam.serviceAccountUser` on the three runtime service accounts
   - `roles/firebaserules.admin`
   - `roles/datastore.indexAdmin`

   Then let the WIF principal for this repository impersonate it (`roles/iam.workloadIdentityUser`).
3. **GitHub environment `staging`:**

   | Kind | Name | Value |
   |---|---|---|
   | variable | `STAGING_GCP_PROJECT` | project ID |
   | variable | `STAGING_REGION` | `asia-south1` |
   | variable | `STAGING_WIF_PROVIDER` | `projects/<number>/locations/global/workloadIdentityPools/github/providers/careloop` |
   | variable | `STAGING_DEPLOY_SA` | `careloop-deploy@<PROJECT_ID>.iam.gserviceaccount.com` |
   | variable | `STAGING_WEB_URL` / `STAGING_VOICE_URL` | Cloud Run URLs (`terraform output urls`) |
   | variable | `STAGING_FIREBASE_WEB_API_KEY` | Firebase console → Project settings → Web API key (public by design) |
   | secret | `STAGING_SMOKE_STAFF_EMAIL` / `STAGING_SMOKE_STAFF_PASSWORD` | a dedicated **synthetic** staff account in the staging lab |

4. **Secrets:** add the webhook signing secret value (JSON `{"sandbox:<account>":"<random 32+ chars>"}`) to Secret Manager `webhook-signing-secrets`, and the `provider_accounts/sandbox__<account>` mapping document.

Terraform ignores image changes on the Cloud Run services, so `terraform apply` won't roll back what the pipeline deployed.
