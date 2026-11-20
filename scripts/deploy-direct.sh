#!/usr/bin/env bash
# Deploys the current checkout to a demo/staging project from this machine,
# without GitHub Actions or local Docker: Cloud Build builds the images, then
# each Cloud Run service is deployed by digest and Firestore rules/indexes are
# released. Never for the pilot project.
#
#   scripts/deploy-direct.sh <project-id>
#
# Needs: gcloud signed in as a project owner, `terraform apply` already done.
set -euo pipefail

PROJECT="${1:?usage: scripts/deploy-direct.sh <project-id>}"
REGION="${REGION:-asia-south1}"
case "$PROJECT" in *pilot* | *prod*) echo "Refusing: $PROJECT looks like a pilot/production project." >&2; exit 1 ;; esac
cd "$(dirname "$0")/.."

TAG="$(git rev-parse --short HEAD)$(git diff --quiet && echo '' || echo "-dirty-$(date +%H%M%S)")"
TOKEN="$(gcloud auth print-access-token)"
APP_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" \
  "https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/webApps" | sed -n 's/.*"appId": "\(.*\)".*/\1/p' | head -1)"
# The browser API key is public by design (it identifies the Firebase project).
API_KEY="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" \
  "https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/webApps/${APP_ID}/config" | sed -n 's/.*"apiKey": "\(.*\)".*/\1/p')"
[ -n "$API_KEY" ] || { echo "No Firebase web app found in $PROJECT." >&2; exit 1; }

echo "Building images ($TAG) with Cloud Build…"
gcloud builds submit --project="$PROJECT" --region="$REGION" --config=infra/cloudbuild.yaml \
  --substitutions="_TAG=${TAG},_REGION=${REGION},_FIREBASE_API_KEY=${API_KEY}" .

REG="${REGION}-docker.pkg.dev/${PROJECT}/careloop"
for svc in web-api worker voice; do
  digest="$(gcloud artifacts docker images describe "$REG/$svc:$TAG" --project="$PROJECT" \
    --format='value(image_summary.fully_qualified_digest)')"
  gcloud run deploy "careloop-$svc" --image "$digest" --region "$REGION" --project "$PROJECT" --quiet
done

echo "Releasing Firestore rules and indexes…"
# Use the gcloud application-default login, not whatever account firebase-tools has stored.
CFG="$(mktemp -d)"
XDG_CONFIG_HOME="$CFG" GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/gcloud/application_default_credentials.json" \
  npx --yes firebase-tools@15.22.3 deploy --only firestore:rules,firestore:indexes --project "$PROJECT" --non-interactive
rm -rf "$CFG" firebase-debug.log

# The project-number URLs: voice allows only this web origin (VOICE_ALLOWED_ORIGINS in infra/main.tf).
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
WEB="https://careloop-web-api-${NUMBER}.${REGION}.run.app"
VOICE="https://careloop-voice-${NUMBER}.${REGION}.run.app"
echo "Smoke test…"
# Signed-in checks use the synthetic logins from bootstrap:staging, if they are for this project.
if [ -f .env.staging.local ] && grep -q "^STAGING_PROJECT=${PROJECT}$" .env.staging.local; then
  SMOKE_STAFF_EMAIL="$(sed -n 's/^STAGING_STAFF_EMAILS=\([^,]*\).*/\1/p' .env.staging.local)"
  SMOKE_STAFF_PASSWORD="$(sed -n 's/^STAGING_STAFF_PASSWORD=//p' .env.staging.local)"
  export SMOKE_STAFF_EMAIL SMOKE_STAFF_PASSWORD
fi
WEB_URL="$WEB" VOICE_URL="$VOICE" FIREBASE_WEB_API_KEY="$API_KEY" pnpm --silent --filter @careloop/scripts smoke
echo "Deployed: $WEB (open this URL; the other Cloud Run URL fails the voice origin check)"
