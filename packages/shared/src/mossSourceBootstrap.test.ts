import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import OS from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RETIRED_PROVIDER_KINDS, SUPPORTED_PROVIDER_KINDS } from "@synara/contracts";

import { parseMossCanonicalConfig } from "./mossConfigProjection";
import {
  computeHookTrustHash,
  getHookTrustStorePath,
  readHookTrustStore,
  resolveHookTrustState,
} from "./mossHookTrust";
import {
  MOSS_STARTER_HOOK_COMMAND,
  MOSS_STARTER_HOOK_EVENT,
  MOSS_STARTER_HOOK_NAME,
  MOSS_STARTER_MEMORY_NAME,
  MOSS_STARTER_SKILL_NAME,
  ensureMossSource,
} from "./mossSourceBootstrap";
import {
  MOSS_RELATIVE_PATHS,
  getMossBootstrapDirectories,
  getMossSourceLayout,
} from "./mossSourceLayout";

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const tempDir = await mkdtemp(join(OS.tmpdir(), "t3-moss-bootstrap-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/** Recursive relative-path -> sha256 manifest of every file under root. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      entries[relative(root, absolutePath)] = createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex");
    }
  }

  await walk(root);
  return entries;
}

describe("ensureMossSource on a blank workspace (A1/A2)", () => {
  it("creates the full resource tree with starter entries", async () => {
    const workspace = await makeTempWorkspace();
    const layout = getMossSourceLayout(workspace);

    const result = await ensureMossSource({ projectPath: workspace });

    expect(result.status).toBe("created");
    expect(result.root).toBe(layout.root);
    expect(result.conflicts).toEqual([]);
    expect(result.skipped).toEqual([]);

    const expectedPaths = [
      layout.root,
      layout.sourceInstruction,
      layout.workspaceConfig,
      layout.providersConfig,
      layout.mcpConfig,
      join(layout.memoryRoot, `${MOSS_STARTER_MEMORY_NAME}.md`),
      join(layout.skillsRoot, MOSS_STARTER_SKILL_NAME, "SKILL.md"),
      join(layout.hooksRoot, `${MOSS_STARTER_HOOK_NAME}.md`),
      getHookTrustStorePath(workspace),
      ...getMossBootstrapDirectories(layout),
    ];
    for (const expectedPath of expectedPaths) {
      expect(existsSync(expectedPath), `missing ${expectedPath}`).toBe(true);
    }
    expect((await lstat(layout.pluginsRoot)).isDirectory()).toBe(true);
    expect((await lstat(layout.subagentsRoot)).isDirectory()).toBe(true);
  });

  it("teaches the starter skill that plugins are canonical Moss source", async () => {
    const workspace = await makeTempWorkspace();
    const layout = getMossSourceLayout(workspace);

    await ensureMossSource({ projectPath: workspace });

    expect(
      await readFile(join(layout.skillsRoot, MOSS_STARTER_SKILL_NAME, "SKILL.md"), "utf8"),
    ).toContain(MOSS_RELATIVE_PATHS.pluginsRoot);
  });

  it("writes a config.json starter that the existing control plane can decode", async () => {
    const workspace = await makeTempWorkspace();
    const layout = getMossSourceLayout(workspace);

    await ensureMossSource({ projectPath: workspace });

    const config = parseMossCanonicalConfig(
      await readFile(layout.workspaceConfig, "utf8"),
      "starter-config",
    );
    expect(config.version).toBe(1);
    expect(config.defaultProvider).toBe("codex");
    expect(Object.keys(config.providers)).toEqual(expect.arrayContaining(["codex", "claudeAgent"]));
    expect(config.mcp).toEqual([]);
    expect(config.skills).toEqual([]);
    expect(config.memory.map((entry) => entry.name)).toEqual([MOSS_STARTER_MEMORY_NAME]);
    expect(config.hooks.map((entry) => entry.name)).toEqual([MOSS_STARTER_HOOK_NAME]);
    expect(config.tools.allow).toEqual([]);
    expect(config.tools.deny).toEqual([]);
  });

  it("enumerates supported providers without restoring retired providers", async () => {
    const workspace = await makeTempWorkspace();
    const layout = getMossSourceLayout(workspace);

    await ensureMossSource({ projectPath: workspace });

    const providersYaml = await readFile(layout.providersConfig, "utf8");
    expect(SUPPORTED_PROVIDER_KINDS).toHaveLength(14);
    for (const provider of SUPPORTED_PROVIDER_KINDS) {
      expect(providersYaml).toContain(`  ${provider}:`);
    }
    for (const provider of RETIRED_PROVIDER_KINDS) {
      expect(providersYaml).not.toContain(`  ${provider}:`);
    }
  });

  it("trusts the managed starter hook at its known content hash", async () => {
    const workspace = await makeTempWorkspace();

    await ensureMossSource({ projectPath: workspace });

    const store = await readHookTrustStore(workspace);
    const entry = store.hooks[MOSS_STARTER_HOOK_NAME];
    expect(entry?.trustedHash).toBe(
      computeHookTrustHash({
        command: MOSS_STARTER_HOOK_COMMAND,
        event: MOSS_STARTER_HOOK_EVENT,
      }),
    );
    expect(resolveHookTrustState({ currentHash: entry?.trustedHash ?? "", entry })).toBe("trusted");
  });
});

describe("ensureMossSource idempotency (A3)", () => {
  it("second run reports skipped and leaves every file byte-identical", async () => {
    const workspace = await makeTempWorkspace();
    const layout = getMossSourceLayout(workspace);

    const first = await ensureMossSource({ projectPath: workspace });
    expect(first.status).toBe("created");
    const before = await snapshotTree(layout.root);

    const second = await ensureMossSource({ projectPath: workspace });

    expect(second.status).toBe("skipped");
    expect(second.created).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expect(second.reason).toBe("Moss Unified Source already exists.");
    expect(await snapshotTree(layout.root)).toEqual(before);
  });
});

describe("ensureMossSource never overwrites user content (A4)", () => {
  it("keeps a pre-existing memory file byte-identical and reports it as skipped", async () => {
    const workspace = await makeTempWorkspace();
    const layout = getMossSourceLayout(workspace);
    const memoryPath = join(layout.memoryRoot, `${MOSS_STARTER_MEMORY_NAME}.md`);
    const customContent = "# my own memory\n\ndo not touch\n";
    await mkdir(layout.memoryRoot, { recursive: true });
    await writeFile(memoryPath, customContent, "utf8");

    const result = await ensureMossSource({ projectPath: workspace });

    expect(result.status).toBe("updated");
    expect(result.skipped).toContain(memoryPath);
    expect(result.created).not.toContain(memoryPath);
    expect(await readFile(memoryPath, "utf8")).toBe(customContent);
  });

  it("leaves tracked canonical root contract documents byte-identical", async () => {
    const workspace = await makeTempWorkspace();
    const layout = getMossSourceLayout(workspace);
    const pluginContract = join(layout.pluginsRoot, "README.md");
    const subagentContract = join(layout.subagentsRoot, "README.md");
    const pluginContent = "# user plugin contract\n";
    const subagentContent = "# user subagent contract\n";
    await mkdir(layout.pluginsRoot, { recursive: true });
    await mkdir(layout.subagentsRoot, { recursive: true });
    await writeFile(pluginContract, pluginContent, "utf8");
    await writeFile(subagentContract, subagentContent, "utf8");

    await ensureMossSource({ projectPath: workspace });

    expect(await readFile(pluginContract, "utf8")).toBe(pluginContent);
    expect(await readFile(subagentContract, "utf8")).toBe(subagentContent);
  });

  it("refuses with a conflict when the Moss root is a plain file and creates nothing", async () => {
    const workspace = await makeTempWorkspace();
    const layout = getMossSourceLayout(workspace);
    await writeFile(layout.root, "not a directory", "utf8");

    const result = await ensureMossSource({ projectPath: workspace });

    expect(result.status).toBe("conflict");
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.conflicts).toEqual([
      { path: layout.root, reason: ".moss exists and is not a directory." },
    ]);
    expect((await lstat(layout.root)).isFile()).toBe(true);
    expect(await readFile(layout.root, "utf8")).toBe("not a directory");
    expect(await readdir(workspace)).toEqual([".moss"]);
  });

  it("leaves a user-authored starter-named hook untrusted and unmodified", async () => {
    const workspace = await makeTempWorkspace();
    const layout = getMossSourceLayout(workspace);
    const hookPath = join(layout.hooksRoot, `${MOSS_STARTER_HOOK_NAME}.md`);
    const userHook = "---\nname: session-start\ncommand: rm -rf /\n---\n";
    await mkdir(layout.hooksRoot, { recursive: true });
    await writeFile(hookPath, userHook, "utf8");

    const result = await ensureMossSource({ projectPath: workspace });

    expect(result.skipped).toContain(hookPath);
    expect(await readFile(hookPath, "utf8")).toBe(userHook);
    expect(existsSync(getHookTrustStorePath(workspace))).toBe(false);
    const store = await readHookTrustStore(workspace);
    expect(
      resolveHookTrustState({
        currentHash: computeHookTrustHash({ command: "rm -rf /" }),
        entry: store.hooks[MOSS_STARTER_HOOK_NAME],
      }),
    ).toBe("untrusted");
  });

  it("does not rewrite the trust store when the starter hook already exists (trustedAt stable)", async () => {
    const workspace = await makeTempWorkspace();

    await ensureMossSource({ projectPath: workspace });
    const storePathContent = await readFile(getHookTrustStorePath(workspace), "utf8");

    await ensureMossSource({ projectPath: workspace });

    expect(await readFile(getHookTrustStorePath(workspace), "utf8")).toBe(storePathContent);
    const store = await readHookTrustStore(workspace);
    expect(store.hooks[MOSS_STARTER_HOOK_NAME]?.trustedAt).toBe(
      JSON.parse(storePathContent).hooks[MOSS_STARTER_HOOK_NAME].trustedAt,
    );
  });
});
