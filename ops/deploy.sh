#!/usr/bin/env bash
# The one command to (re)deploy the whole stack:  ./ops/deploy.sh
#  - writes ops/.env with fresh random secrets the first time only
#  - pulls the latest code, rebuilds, applies migrations, restarts services
# Settlement stops on SIGTERM and lets an in-flight batch transaction commit
# or roll back (each batch is one DB transaction), so a redeploy never
# leaves a half-written settlement run.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f ops/.env ] || ./ops/gen-secrets.sh
git pull --ff-only || true
docker compose -f ops/docker-compose.yml --env-file ops/.env up -d --build --remove-orphans
docker compose -f ops/docker-compose.yml --env-file ops/.env ps
