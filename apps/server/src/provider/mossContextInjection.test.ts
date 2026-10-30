import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import OS from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildMossRuntimeContext } from "@synara/shared/mossRuntimeContext";

import {
  MOSS_CONTEXT_BLOCK_PREFIX,
  buildMossContextBootstrapText,
} from "./mossContextInjection.ts";

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const tempDir = await mkdtemp(join(OS.tmpdir(), "t3-moss-context-injection-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeMossWorkspace(): Promise<string> {
  const workspace = await makeTempWorkspace();
  await mkdir(join(workspace, ".moss", "memory"), { recursive: true });
  await writeFile(
    join(workspace, ".moss", "memory", "release.md"),
    "---\nname: release\n---\nRelease codename: MOSS_SY6_WRAP_OK\n",
    "utf8",
  );
  return workspace;
}

describe("buildMossContextBootstrapText", () => {
  it("wraps the hydrated context in a fingerprinted moss_context block", async () => {
    const workspace = await makeMossWorkspace();
    const bootstrap = await buildMossContextBootstrapText({
      cwd: workspace,
      provider: "codex",
      maxChars: 40_000,
    });

    expect(bootstrap).not.toBeNull();
    expect(bootstrap?.text.startsWith(MOSS_CONTEXT_BLOCK_PREFIX)).toBe(true);
    expect(bootstrap?.text.endsWith("</moss_context>")).toBe(true);
    expect(bootstrap?.text).toContain("Release codename: MOSS_SY6_WRAP_OK");
    expect(bootstrap?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(bootstrap?.text).toContain(`fingerprint="sha256:${bootstrap?.fingerprint}"`);
    expect(bootstrap?.includedResourceCount).toBe(1);

    // The advertised fingerprint matches an independent rebuild over the same
    // fixture, so downstream consumers can verify the block byte-for-byte.
    const independent = await buildMossRuntimeContext({
      projectPath: workspace,
      provider: "codex",
    });
    expect(bootstrap?.fingerprint).toBe(independent.fingerprint);
  });

  it("returns null when the workspace has no .moss source", async () => {
    const workspace = await makeTempWorkspace();
    const bootstrap = await buildMossContextBootstrapText({
      cwd: workspace,
      provider: "codex",
      maxChars: 40_000,
    });
    expect(bootstrap).toBeNull();
  });

  it("returns null when the budget is too small for meaningful context", async () => {
    const workspace = await makeMossWorkspace();
    const bootstrap = await buildMossContextBootstrapText({
      cwd: workspace,
      provider: "codex",
      maxChars: 200,
    });
    expect(bootstrap).toBeNull();
  });

  it("never exceeds maxChars even when the context is truncated to fit", async () => {
    const workspace = await makeMossWorkspace();
    await writeFile(
      join(workspace, ".moss", "memory", "huge.md"),
      `---\nname: huge\n---\n${"y".repeat(20_000)}\n`,
      "utf8",
    );

    const maxChars = 2_000;
    const bootstrap = await buildMossContextBootstrapText({
      cwd: workspace,
      provider: "codex",
      maxChars,
    });
    expect(bootstrap).not.toBeNull();
    expect(bootstrap!.text.length).toBeLessThanOrEqual(maxChars);
    expect(bootstrap!.text).toContain("[context truncated]");
  });
});
