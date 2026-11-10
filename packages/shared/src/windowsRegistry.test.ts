import { describe, expect, it, vi } from "vitest";

import { queryWindowsRegistry, readWindowsRegistryString } from "./windowsRegistry";

const encode = (text: string) => new TextEncoder().encode(text);

describe("windows registry reads", () => {
  it("returns null for a missing key without throwing or printing", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write");
    const run = vi.fn(() => ({ status: 1, stdout: new Uint8Array(0) }));
    try {
      expect(
        readWindowsRegistryString(
          "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{missing}",
          "InstallLocation",
          { run },
        ),
      ).toBeNull();
      expect(run).toHaveBeenCalledWith([
        "query",
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{missing}",
        "/v",
        "InstallLocation",
      ]);
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("reads a string value, including one with spaces", () => {
    const output = encode(
      "\r\nHKEY_CURRENT_USER\\Software\\Moss\r\n    InstallLocation    REG_SZ    C:\\Program Files\\Moss\r\n\r\n",
    );
    expect(
      readWindowsRegistryString("HKCU\\Software\\Moss", "InstallLocation", {
        run: () => ({ status: 0, stdout: output }),
      }),
    ).toBe("C:\\Program Files\\Moss");
  });

  it.runIf(process.platform === "win32")(
    "asks the real reg.exe about a missing key quietly (read-only)",
    () => {
      const stderrWrite = vi.spyOn(process.stderr, "write");
      try {
        expect(
          readWindowsRegistryString(`HKCU\\Software\\MossMissingKey${Date.now()}`, "Anything"),
        ).toBeNull();
        expect(stderrWrite).not.toHaveBeenCalled();
      } finally {
        stderrWrite.mockRestore();
      }
    },
  );

  it("returns null when the query cannot run at all", () => {
    expect(
      queryWindowsRegistry(["HKCU\\Environment"], {
        run: () => {
          throw new Error("spawn reg.exe ENOENT");
        },
      }),
    ).toBeNull();
  });
});
