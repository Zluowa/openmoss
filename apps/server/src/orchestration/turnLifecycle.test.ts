import { describe, expect, it } from "vitest";

import { settleTurnStateFromSession } from "./turnLifecycle.ts";

describe("settleTurnStateFromSession", () => {
  it("does not attribute an automatic stopped session exit to the user", () => {
    expect(settleTurnStateFromSession({ status: "stopped", activeTurnId: null }, "running")).toBe(
      "completed",
    );
  });

  it("preserves explicit interrupt attribution", () => {
    expect(
      settleTurnStateFromSession({ status: "interrupted", activeTurnId: null }, "running"),
    ).toBe("interrupted");
  });
});
