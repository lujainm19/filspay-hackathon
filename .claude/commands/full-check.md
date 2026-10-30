---
description: Fresh database, every migration, every TS and Go test, typecheck
---

Run `./scripts/ai/fresh_test.sh` and report, per package, how many tests ran
and how many failed. For any failure, show the assertion and say whether it is
a real bug, a test that depends on another test's data, or an environment
problem — and how you know. Do not change code in this command.
