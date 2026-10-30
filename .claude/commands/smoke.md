---
description: End-to-end check of a running stack over HTTP (scripts/e2e_smoke.ts)
argument-hint: <base url> <path to the api log>
---

Run the end-to-end smoke test against $ARGUMENTS:

`BASE_URL=<base url> API_LOG=<api log> DATABASE_URL=... ACQUIRER_CALLBACK_SIGNING_SECRET=... npx tsx scripts/e2e_smoke.ts`

It needs the seeded demo data and `OTP_LOG_CODES=true` on the API. List every
FAIL line, then for each one find out whether the app or the test is wrong
before proposing a change (see /verify-finding).
