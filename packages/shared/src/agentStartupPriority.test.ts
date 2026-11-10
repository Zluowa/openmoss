import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_STARTUP_PRIORITY_GRACE_MS,
  cancelAgentStartupPriority,
  deferAgentPriorityUntilReady,
  hasPendingAgentStartupPriority,
  settleAgentStartupPriority,
  shouldDeferAgentPriority,
} from "./agentStartupPriority";
import { spawnProcess } from "./processRuntime";

describe("agent startup priority", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defers only on Windows, where priority classes are strict", () => {
    expect(shouldDeferAgentPriority("win32")).toBe(true);
    expect(shouldDeferAgentPriority("linux")).toBe(false);
    expect(shouldDeferAgentPriority("darwin")).toBe(false);
  });

  it("lowers once, when the owner reports ready", () => {
    vi.spyOn(os, "getPriority").mockReturnValue(0);
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    const owner = {};
    deferAgentPriorityUntilReady(owner, { pid: 4242, platform: "win32" });
    expect(setPriority).not.toHaveBeenCalled();
    settleAgentStartupPriority(owner);
    settleAgentStartupPriority(owner);
    expect(setPriority).toHaveBeenCalledTimes(1);
    expect(setPriority).toHaveBeenCalledWith(4242, os.constants.priority.PRIORITY_BELOW_NORMAL);
    expect(hasPendingAgentStartupPriority(owner)).toBe(false);
  });

  it("lowers after the grace when the owner never reports ready", () => {
    vi.useFakeTimers();
    vi.spyOn(os, "getPriority").mockReturnValue(0);
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    const owner = {};
    deferAgentPriorityUntilReady(owner, { pid: 4243, platform: "win32" });
    vi.advanceTimersByTime(AGENT_STARTUP_PRIORITY_GRACE_MS - 1);
    expect(setPriority).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setPriority).toHaveBeenCalledWith(4243, os.constants.priority.PRIORITY_BELOW_NORMAL);
  });

  it("never touches a PID after its process is gone", () => {
    vi.useFakeTimers();
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    const owner = {};
    deferAgentPriorityUntilReady(owner, { pid: 4244, platform: "win32" });
    cancelAgentStartupPriority(owner);
    settleAgentStartupPriority(owner);
    vi.advanceTimersByTime(AGENT_STARTUP_PRIORITY_GRACE_MS * 2);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")(
    "starts a real Windows agent at normal priority and lowers it when ready",
    async () => {
      const serverPriority = os.getPriority();
      const child = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
        lowerPriority: true,
        deferPriorityUntilReady: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      try {
        await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
        expect(os.getPriority(child.pid!)).toBe(serverPriority);
        settleAgentStartupPriority(child);
        expect(os.getPriority(child.pid!)).toBe(
          Math.max(serverPriority, os.constants.priority.PRIORITY_BELOW_NORMAL),
        );
      } finally {
        child.kill();
      }
    },
  );

  // The setting exists so agents' work does not take CPU from the person's own programs
  // (upstream #1577). Only the handshake runs at normal priority: a tool the agent starts
  // after it is ready must still inherit the below-normal class.
  it.runIf(process.platform === "win32")(
    "keeps tools the ready agent starts at the configured lower priority",
    async () => {
      const serverPriority = os.getPriority();
      const script = [
        "process.stdin.once('data', () => {",
        "  const tool = require('node:child_process').spawnSync(process.execPath,",
        "    ['-e', 'console.log(require(\"node:os\").getPriority())'], { encoding: 'utf8' });",
        "  console.log(tool.stdout.trim());",
        "  process.exit(0);",
        "});",
      ].join("\n");
      const agent = spawnProcess(process.execPath, ["-e", script], {
        lowerPriority: true,
        deferPriorityUntilReady: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        await new Promise<void>((resolve) => agent.once("spawn", () => resolve()));
        expect(os.getPriority(agent.pid!)).toBe(serverPriority);
        settleAgentStartupPriority(agent);
        const output = new Promise<string>((resolve) => {
          let text = "";
          agent.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
          agent.once("exit", () => resolve(text.trim()));
        });
        agent.stdin.write("start tool\n");
        expect(Number(await output)).toBe(
          Math.max(serverPriority, os.constants.priority.PRIORITY_BELOW_NORMAL),
        );
      } finally {
        agent.kill();
      }
    },
  );

  it.runIf(process.platform === "win32")("forgets the lowering when the agent exits", async () => {
    const child = spawnProcess(process.execPath, ["-e", "process.exit(0)"], {
      lowerPriority: true,
      deferPriorityUntilReady: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(hasPendingAgentStartupPriority(child)).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "keeps lowering at spawn for callers that do not defer",
    async () => {
      const serverPriority = os.getPriority();
      const lowered = spawnProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
        lowerPriority: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      try {
        await new Promise<void>((resolve) => lowered.once("spawn", () => resolve()));
        expect(os.getPriority(lowered.pid!)).toBe(
          Math.max(serverPriority, os.constants.priority.PRIORITY_BELOW_NORMAL),
        );
        expect(hasPendingAgentStartupPriority(lowered)).toBe(false);
      } finally {
        lowered.kill();
      }
    },
  );
});
