import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// A Node without zstd (older than 22.15 / 23.8) must fail cleanly, never write a half runtime.
vi.mock("node:zlib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:zlib")>()),
  createZstdDecompress: undefined,
}));

const { AgentRuntimeStoreError, installAgentRuntimeArchive } = await import("./agentRuntimeStore");

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("agent runtime store without zstd", () => {
  it("refuses with `unsupported` and installs nothing", async () => {
    const store = mkdtempSync(join(tmpdir(), "moss-nozstd-"));
    folders.push(store);
    writeFileSync(join(store, "a.tar.zst"), "x");
    const failure = await installAgentRuntimeArchive({
      archivePath: join(store, "a.tar.zst"),
      storeRoot: store,
      pin: {
        name: "codex",
        version: "1",
        platform: "win32",
        arch: "x64",
        archive: { size: 1, sha256: "0".repeat(64) },
        executable: "codex.exe",
        files: [],
      },
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(AgentRuntimeStoreError);
    expect(failure.failure).toBe("unsupported");
  });
});
