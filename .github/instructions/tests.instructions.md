---
applyTo: "test/**"
---

Bun's test runner (`bun:test`). Tests run with stubs; CI sets `KEELSON_USE_STUBS=1`.

Do NOT flag in this directory:

- Missing docstrings or comments on test helpers.
- Mock-vs-real tradeoffs, or the fakes under `test/helpers/`.
- A test that reads another part of the package's source as a drift guard.

Do flag a test that asserts nothing, or one that loosens a fail-closed
expectation — e.g. accepting an invalid board where the production path would
reject it.
