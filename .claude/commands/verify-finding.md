---
description: Prove a suspected bug before touching code, then fix it the smallest way
argument-hint: <finding id or one-line description>
---

Finding: $ARGUMENTS

Follow CLAUDE.md ("Treat everything as a claim to verify"). Do these in order
and show the output of each step; do not skip ahead.

1. Find the code path. Quote the lines (file:line) that cause the behaviour.
   Comments, ADRs, postmortems and "Claude/copilot says" notes are claims, not
   evidence: check each one you rely on against the code.
2. Write a regression test in a new `*.new.test.ts` (API) or `*_fixes_test.go`
   (Go) that FAILS on the current code because of this bug. Run it and show the
   failure. If you cannot make it fail, stop and say so: the bug may not exist.
3. Make the smallest fix. Money is integer fils (1 BD = 1000), the business day
   is Asia/Bahrain, merchant scope comes from the login only.
4. Run the new test (now passing) and the package's whole suite.
5. Say what the fix does to rows already in the database, and whether a
   migration is needed (next free number in db/migrations).
6. Add or update the row in docs/FINDINGS.md: symptom, root cause, fix, test.
