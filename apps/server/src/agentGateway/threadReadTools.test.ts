import { describe, expect, it } from "vitest";

import { buildMossContextCapabilities } from "./threadReadTools.ts";

describe("Moss context capability projection", () => {
  it("reports history grants independently and truthfully", () => {
    expect(buildMossContextCapabilities(new Set(["thread:read"]), null).computerHistory).toEqual({
      status: false,
      query: false,
      readOnly: true,
      notImplicitlyInjected: true,
    });

    expect(
      buildMossContextCapabilities(
        new Set(["thread:read", "history:status", "history:query"]),
        "turn-history",
      ).computerHistory,
    ).toEqual({
      status: true,
      query: true,
      readOnly: true,
      notImplicitlyInjected: true,
    });
  });
});
