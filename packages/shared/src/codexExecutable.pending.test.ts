import { describe, expect, it } from "vitest";

import { resolveCodexExecutable } from "./codexExecutable";
import { AgentRuntimePendingError, BundledCodexRuntimeUnavailableError } from "./codexRuntime";

describe("Codex while a download build is still fetching it", () => {
  it("says it is being prepared, never that it is damaged or missing", () => {
    let failure: unknown;
    try {
      resolveCodexExecutable({
        env: { MOSS_AGENT_RUNTIMES_PENDING: "codex,claude" },
        isOnPath: () => false,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AgentRuntimePendingError);
    // Every path that keeps a damaged bundle away from npm keeps this one away too.
    expect(failure).toBeInstanceOf(BundledCodexRuntimeUnavailableError);
    expect((failure as Error).message).toBe(
      "正在准备智能体，首次使用需要下载。下载完成后会自动继续。",
    );
  });

  it("uses the person's own Codex meanwhile, and Moss's once the desktop reports it ready", () => {
    expect(
      resolveCodexExecutable({
        env: { MOSS_AGENT_RUNTIMES_PENDING: "codex" },
        isOnPath: () => true,
      }).source,
    ).toBe("path");
    expect(
      resolveCodexExecutable({
        env: { MOSS_BUNDLED_CODEX_PATH: process.execPath, MOSS_AGENT_RUNTIMES_PENDING: "claude" },
        isOnPath: () => false,
      }),
    ).toEqual({ binaryPath: process.execPath, source: "bundled" });
  });
});
