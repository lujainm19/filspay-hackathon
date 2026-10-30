#!/usr/bin/env sh
# Recreates the test database, applies every migration and runs every test:
# TypeScript (all workspaces + scripts), Go settlement, then the typecheck.
# Used by the /full-check command. Needs a local Postgres where the current
# user can create databases. TEST_DB defaults to filspay_test.
set -eu
DB="${TEST_DB:-filspay_test}"
BASE="${PG_BASE_URL:-postgres://filspay:filspay@localhost:5432}"
cd "$(dirname "$0")/../.."
psql "$BASE/postgres" -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
export DATABASE_URL="$BASE/$DB"
npm run migrate
npm test
(cd apps/settlement && go test -p 1 -count=1 ./...)
npm run typecheck
echo "fresh_test: all green"
