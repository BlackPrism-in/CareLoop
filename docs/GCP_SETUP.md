# Google Cloud setup from scratch

Use the **same Google account as your Google Developer Program profile** (me.developers.google.com), because that's where the credits land. Do every step below while signed in with it.

## 1. Confirm the credits
1. Open https://console.cloud.google.com/billing and pick the billing account that holds the Developer Program credit.
2. Go to **Credits**. Note the amount, the expiry date and the **eligible services**. You need Vertex AI (Gemini), Cloud Run, Firestore, Cloud Storage and Cloud Tasks.
3. If the credit only appears in Google AI Studio (Gemini API) and not in Cloud Billing, use the Developer API path in step 5b instead of Vertex.

## 2. Create the demo project
1. Go to https://console.cloud.google.com/projectcreate. Name it `careloop-demo`. Google adds a suffix if the ID is taken; that final project ID is what you'll use below.
2. Go to **Billing → Link a billing account** and choose the account from step 1.
3. Create the pilot project the same way later (`careloop-pilot`). Keep it separate.

## 3. Local CLI login
Run each of these, replacing `<PROJECT_ID>`:

```bash
gcloud auth login
```

```bash
gcloud config set project <PROJECT_ID>
```

```bash
gcloud auth application-default login
```

```bash
gcloud services enable aiplatform.googleapis.com
```

## 4. Firebase (staff login)
1. Go to https://console.firebase.google.com → **Add project** → choose the existing `<PROJECT_ID>`.
2. **Authentication → Get started → Sign-in method → Email/Password**: enable it.
3. Phase 2 creates the staff test users. Locally the Auth emulator is used, so you don't need anything else yet.

## 5. Fill in `.env.local` (decision 2)
Copy the template once:

```bash
cp .env.example .env.local
```

Then edit `.env.local` in the repo root. It is git-ignored and never committed:

| Key | Value |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | your project ID from step 2 |
| `GOOGLE_API_SURFACE` | `vertex` (5a) or `gemini-developer` (5b) |
| `GOOGLE_CLOUD_LOCATION` | `global` |
| `LIVE_MODEL_LOCATION` | `us-central1` |
| `INTAKE_MODEL_ID` | `gemini-3.5-flash-lite` |
| `COORDINATION_MODEL_ID` | `gemini-3.8-flash` |
| `VERIFICATION_MODEL_ID` | `gemini-3.8-flash` |
| `LIVE_MODEL_ID` | `gemini-3.8-live` |

**5a, Vertex (recommended):** no key is needed, because it uses your `gcloud auth application-default login`.
**5b, Gemini Developer API:** create a key at https://aistudio.google.com/apikey and add `GEMINI_API_KEY=...` to `.env.local` only. Never put it anywhere else.

Then check access:

```bash
pnpm check:models
```

All four rows must say `OK`.

### Model names (checked 20 Nov 2026 against Google's model pages)
| Role | Model ID | Status | Vertex locations |
|---|---|---|---|
| Intake | `gemini-3.5-flash-lite` | Stable | global, us, eu, asia-south1 (Mumbai: not on standard pay-as-you-go) |
| Coordination / verification | `gemini-3.8-flash` | Stable | global, us, eu, asia-northeast1. **Not Mumbai.** |
| Conversation | `gemini-3.8-live` | Stable | us, eu, us-central1. **Not Mumbai, not global.** |

Consequences:
- **Live voice audio is processed in the US or EU, not India.** That's acceptable for the synthetic-data demo. For the pilot it belongs in the processor/data-location review (Blueprint p.8). Don't claim India-only processing.
- Google's Live language table lists Hindi (`hi-IN`), English (India) (`en-IN`, bundled with Hindi), Bengali (`bn-BD`), and Nepali (`ne`, supported on Gemini 3.8 Live). Run local-speaker evaluation for Bengali and Nepali before enabling patient sessions in those languages; Bengali is currently tagged for Bangladesh locale in the model API.

## 6. Terraform state bucket and apply
Create the state bucket:

```bash
gcloud storage buckets create gs://<PROJECT_ID>-tfstate --location=asia-south1 --uniform-bucket-level-access
```

```bash
gcloud storage buckets update gs://<PROJECT_ID>-tfstate --versioning
```

Copy `infra/envs/demo.tfvars.example` to `infra/envs/demo.tfvars` (git-ignored) and fill in the project ID and the model IDs above. Then:

```bash
terraform -chdir=infra init -backend-config="bucket=<PROJECT_ID>-tfstate"
```

```bash
terraform -chdir=infra apply -var-file=envs/demo.tfvars
```

The first apply deploys placeholder "hello" containers. Real images come with the first deploy pipeline (Phase 6).
