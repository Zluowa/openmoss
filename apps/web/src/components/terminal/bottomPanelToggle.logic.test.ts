import { describe, expect, it } from "vitest";

import { resolveBottomPanelToggle } from "./bottomPanelToggle.logic";

describe("resolveBottomPanelToggle", () => {
  it("closes an already-open drawer", () => {
    expect(
      resolveBottomPanelToggle({
        terminalOpen: true,
        presentationMode: "drawer",
      }),
    ).toEqual({
      terminalOpen: false,
      presentationMode: "drawer",
      requestFocus: false,
    });
  });

  it("opens a closed terminal as the bottom drawer", () => {
    expect(
      resolveBottomPanelToggle({
        terminalOpen: false,
        presentationMode: "drawer",
      }),
    ).toEqual({
      terminalOpen: true,
      presentationMode: "drawer",
      requestFocus: true,
    });
  });

  it("moves an open workspace terminal into the bottom drawer instead of closing it", () => {
    expect(
      resolveBottomPanelToggle({
        terminalOpen: true,
        presentationMode: "workspace",
      }),
    ).toEqual({
      terminalOpen: true,
      presentationMode: "drawer",
      requestFocus: true,
    });
  });
});
