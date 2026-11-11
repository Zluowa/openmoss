# Browser test quarantine

Moved. Every quarantined test, browser or unit, is listed in `test-quarantine.json` at the
repository root; `tools/test-quarantine/README.md` explains the rules.

The `[geometry:linux]` cases are its `geometry` entry: the stable browser lanes filter out every
test whose name carries that tag, and the geometry lane (`test:browser:geometry`) runs them
without blocking. `scripts/browser-ci-partitions.test.ts` pins the tagged inventory at 5 cases,
so adding a tag is a reviewed change.
