// Fixture for tools/test-quarantine/test/plugin.test.ts; quarantined as a whole file there.
import { expect, it } from "vitest";

it("would fail if it ran", () => {
  expect("ran").toBe("skipped");
});
