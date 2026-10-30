import { describe, expect, it } from "vitest";

import {
  looksLikeComputerPermissionsBlocked,
  parseComputerUseSlashAction,
  summarizeComputerControlToast,
} from "./composerSlashCommands";

describe("computer-use slash helpers", () => {
  it("parses on/off/status and bare enable", () => {
    expect(parseComputerUseSlashAction("")).toBe("on");
    expect(parseComputerUseSlashAction("on")).toBe("on");
    expect(parseComputerUseSlashAction("off")).toBe("off");
    expect(parseComputerUseSlashAction("status")).toBe("status");
    expect(parseComputerUseSlashAction("maybe")).toBe("invalid");
  });

  it("detects permission-blocked provision summaries", () => {
    expect(
      looksLikeComputerPermissionsBlocked(
        "Moss Computer Use needs permission: Accessibility (System Settings → Privacy & Security → Accessibility → allow Moss).",
      ),
    ).toBe(true);
    expect(
      looksLikeComputerPermissionsBlocked(
        "Moss Computer Use is attached on macOS and is waiting for desktop permissions.",
      ),
    ).toBe(true);
    expect(looksLikeComputerPermissionsBlocked("Moss Computer Use is ready on macOS.")).toBe(false);
  });

  it("summarizes enable toasts without Settings-only copy", () => {
    const text = summarizeComputerControlToast({
      enabled: true,
      availabilityKind: "available",
      backend: "cua",
      inputCapable: true,
      captureCapable: true,
      provisionSummary: "Moss Computer Use is ready on macOS.",
    });
    expect(text).toContain("enabled");
    expect(text).toContain("cua");
    expect(text).not.toMatch(/Review Computer control in Settings/i);
  });
});
