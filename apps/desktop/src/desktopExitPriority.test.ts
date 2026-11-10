import { describe, expect, it, vi } from "vitest";

import { raiseDesktopExitPriority } from "./desktopExitPriority";

describe("raiseDesktopExitPriority", () => {
  it("raises every helper process once, then this process", () => {
    const raised: number[] = [];
    raiseDesktopExitPriority({
      platform: "win32",
      listHelperPids: () => [process.pid, 41, 42, 41],
      raise: (pid) => raised.push(pid),
    });
    expect(raised).toEqual([41, 42, 0]);
  });

  it("still raises this process when helper metrics or a helper fail", () => {
    const raised: number[] = [];
    raiseDesktopExitPriority({
      platform: "win32",
      listHelperPids: () => {
        throw new Error("metrics unavailable");
      },
      raise: (pid) => raised.push(pid),
    });
    expect(raised).toEqual([0]);

    const failing = vi.fn((pid: number) => {
      if (pid === 41) throw new Error("already gone");
    });
    raiseDesktopExitPriority({ platform: "win32", listHelperPids: () => [41, 42], raise: failing });
    expect(failing.mock.calls.map(([pid]) => pid)).toEqual([41, 42, 0]);
  });

  it.each(["darwin", "linux"] as const)("does nothing on %s", (platform) => {
    const raise = vi.fn();
    raiseDesktopExitPriority({ platform, listHelperPids: () => [41], raise });
    expect(raise).not.toHaveBeenCalled();
  });
});
