import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { installWindowsExitPriority } from "./windowsExitPriority";

describe("installWindowsExitPriority", () => {
  it("raises the priority once the process exits, not before", () => {
    const target = new EventEmitter();
    const raise = vi.fn();

    installWindowsExitPriority(target as unknown as Pick<NodeJS.Process, "once">, raise);
    expect(raise).not.toHaveBeenCalled();

    target.emit("exit", 0);
    target.emit("exit", 0);
    expect(raise).toHaveBeenCalledTimes(1);
  });
});
