import { describe, expect, it } from "vitest";

import { resolveCustomizeSearchAvailability } from "./MossCustomizeSecondarySidebar";

describe("MossCustomizeSecondarySidebar search", () => {
  it("keeps search enabled when a host supplies a callback", () => {
    expect(
      resolveCustomizeSearchAvailability({ hasSearchHandler: true, hasSearchTarget: false }),
    ).toBe(true);
  });

  it("keeps search enabled when the browse destination owns the field", () => {
    expect(
      resolveCustomizeSearchAvailability({ hasSearchHandler: false, hasSearchTarget: true }),
    ).toBe(true);
  });

  it("disables search on detail and management pages without a target", () => {
    expect(
      resolveCustomizeSearchAvailability({ hasSearchHandler: false, hasSearchTarget: false }),
    ).toBe(false);
  });
});
