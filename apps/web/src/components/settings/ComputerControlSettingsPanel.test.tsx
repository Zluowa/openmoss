import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const harness = vi.hoisted(() => ({
  getStatus: vi.fn(),
  provision: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    computer: {
      getStatus: harness.getStatus,
      provision: harness.provision,
    },
  }),
}));

import { ComputerControlSettingsPanel } from "./ComputerControlSettingsPanel";

describe("ComputerControlSettingsPanel", () => {
  beforeEach(() => {
    harness.getStatus.mockReset();
    harness.provision.mockReset();
  });

  it("renders the Computer control heading", () => {
    harness.getStatus.mockResolvedValue({
      computerId: "desktop",
      availability: { kind: "available", backend: "cua" },
      health: {
        status: "connected",
        consecutiveFailures: 0,
        reconnects: 0,
        captureAvailable: true,
      },
      capabilities: {
        windows: false,
        windowBounds: false,
        stacking: false,
        capture: true,
        input: true,
        clipboard: false,
        focus: false,
        raise: false,
        ghostCursor: false,
        visibleDesktop: true,
      },
    });
    harness.provision.mockResolvedValue({
      summary: "Moss Computer Use is ready on macOS.",
      status: {},
    });

    const html = renderToStaticMarkup(<ComputerControlSettingsPanel />);
    expect(html).toContain("Computer control");
    expect(html).toContain("Checking status");
  });
});
