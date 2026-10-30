#!/usr/bin/env sh
# Writes ops/.env with fresh random secrets (does not overwrite an existing one).
set -eu
cd "$(dirname "$0")"
[ -f .env ] && { echo "ops/.env already exists; not overwriting"; exit 0; }
rand() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
cat > .env <<ENV
SITE_ADDRESS=${SITE_ADDRESS:-:80}
ADMIN_ADDRESS=${ADMIN_ADDRESS:-:8080}
COOKIE_SECURE=${COOKIE_SECURE:-false}
OTP_LOG_CODES=${OTP_LOG_CODES:-false}
POSTGRES_PASSWORD=$(rand 24 | tr -d '/+=')
WEBHOOK_SECRET_ENCRYPTION_KEY=$(rand 32)
SETTLEMENT_INTERNAL_TOKEN=$(rand 32 | tr -d '/+=')
ACQUIRER_CALLBACK_SIGNING_SECRET=$(rand 32 | tr -d '/+=')
ENV
chmod 600 .env
echo "wrote ops/.env"
