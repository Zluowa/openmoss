import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lowerProcessPriority, raiseProcessPriorityForExit } from "./platformProcess";

describe("lowerProcessPriority", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["darwin", "linux"] as const)("uses moderate CPU priority on %s", (platform) => {
    vi.spyOn(os, "getPriority").mockReturnValue(0);
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    lowerProcessPriority(12345, { platform });
    expect(setPriority).toHaveBeenCalledWith(12345, 5);
  });

  it("uses the below-normal class on Windows", () => {
    vi.spyOn(os, "getPriority").mockReturnValue(0);
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    lowerProcessPriority(12345, { platform: "win32" });
    expect(setPriority).toHaveBeenCalledWith(12345, os.constants.priority.PRIORITY_BELOW_NORMAL);
  });

  it("does not raise an already lower priority", () => {
    vi.spyOn(os, "getPriority").mockReturnValue(15);
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    lowerProcessPriority(12345, { platform: "linux" });
    expect(setPriority).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, NaN, process.pid])(
    "never reprioritizes an invalid or server PID: %s",
    (pid) => {
      const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
      lowerProcessPriority(pid);
      expect(setPriority).not.toHaveBeenCalled();
    },
  );

  it.each(["getPriority", "setPriority"] as const)("logs and ignores %s failures", (operation) => {
    vi.spyOn(os, "getPriority").mockReturnValue(0);
    vi.spyOn(os, "setPriority").mockImplementation(() => {});
    vi.spyOn(os, operation).mockImplementation(() => {
      throw new Error("access denied");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => lowerProcessPriority(12345)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("12345"), expect.any(Error));
  });
});

describe("raiseProcessPriorityForExit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("raises an exiting process to the high class on Windows", () => {
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    expect(raiseProcessPriorityForExit(12345, { platform: "win32" })).toBe(true);
    expect(setPriority).toHaveBeenCalledWith(12345, os.constants.priority.PRIORITY_HIGH);
  });

  it("accepts 0 for this process", () => {
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    expect(raiseProcessPriorityForExit(0, { platform: "win32" })).toBe(true);
    expect(setPriority).toHaveBeenCalledWith(0, os.constants.priority.PRIORITY_HIGH);
  });

  it.each(["darwin", "linux"] as const)("leaves %s alone", (platform) => {
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    expect(raiseProcessPriorityForExit(12345, { platform })).toBe(false);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it.each([undefined, -1, 1.5, NaN])("ignores an invalid PID: %s", (pid) => {
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    expect(raiseProcessPriorityForExit(pid, { platform: "win32" })).toBe(false);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it("never throws when the process is gone or not ours", () => {
    vi.spyOn(os, "setPriority").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(raiseProcessPriorityForExit(12345, { platform: "win32" })).toBe(false);
  });
});
