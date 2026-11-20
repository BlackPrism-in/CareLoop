#!/usr/bin/env bash
# Boots the production builds (worker/voice bundles, web-api standalone) and
# checks their health endpoints. Catches bundling regressions such as missing
# CommonJS globals before an image is built. No database access is needed.
set -euo pipefail
cd "$(dirname "$0")/.."
export INTAKE_MODEL_ID=check COORDINATION_MODEL_ID=check VERIFICATION_MODEL_ID=check LIVE_MODEL_ID=check
export GOOGLE_CLOUD_PROJECT=demo-careloop APP_ENV=demo
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
(cd apps/worker && PORT=18081 exec node dist/server.js) & pids+=($!)
(cd apps/voice && PORT=18082 exec node dist/server.js) & pids+=($!)
PORT=18080 HOSTNAME=127.0.0.1 node apps/web-api/.next/standalone/apps/web-api/server.js & pids+=($!)
for url in http://127.0.0.1:18081/healthz http://127.0.0.1:18082/healthz http://127.0.0.1:18080/api/health; do
  for i in $(seq 1 30); do curl -sf "$url" >/dev/null && break; sleep 1; done
  curl -sf "$url" >/dev/null || { echo "FAILED: $url"; exit 1; }
  echo "ok  $url"
done
