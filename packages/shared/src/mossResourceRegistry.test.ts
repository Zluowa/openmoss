import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import OS from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";

import { computeHookTrustHash } from "./mossHookTrust";
import {
  discoverMossSourceResources,
  isSafeEntryName,
  MossPluginIRSchema,
  validateMossPluginManifest,
  validateMossPluginMarketplaceEntry,
  type MossSharedResource,
} from "./mossResourceRegistry";
import {
  MOSS_STARTER_HOOK_COMMAND,
  MOSS_STARTER_HOOK_EVENT,
  MOSS_STARTER_HOOK_NAME,
  MOSS_STARTER_MEMORY_NAME,
  MOSS_STARTER_SKILL_NAME,
  ensureMossSource,
} from "./mossSourceBootstrap";
import { getMossSourceLayout } from "./mossSourceLayout";

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const tempDir = await mkdtemp(join(OS.tmpdir(), "t3-moss-registry-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function byId(resources: MossSharedResource[]): Map<string, MossSharedResource> {
  return new Map(resources.map((resource) => [resource.id, resource]));
}

describe("discoverMossSourceResources", () => {
  it("returns an empty list when the workspace has no .moss root", async () => {
    const workspace = await makeTempWorkspace();
    expect(await discoverMossSourceResources(workspace)).toEqual([]);
  });

  it("discovers every bootstrapped starter resource with roles and metadata", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });

    const resources = await discoverMossSourceResources(workspace);
    const index = byId(resources);

    const instruction = index.get("moss:instruction:moss.md");
    expect(instruction?.kind).toBe("instruction");
    expect(instruction?.metadata.mossRole).toBe("source-instruction");
    expect(instruction?.metadata.sourceSystem).toBe("moss-unified-source");

    const workspaceConfig = index.get("moss:instruction:config.json");
    expect(workspaceConfig?.metadata.mossRole).toBe("workspace-config");

    const memoryRoot = index.get("moss:memory:Moss memory");
    expect(memoryRoot?.metadata.mossRole).toBe("memory-root");

    const provider = index.get("moss:provider:providers.yaml");
    expect(provider?.kind).toBe("provider");
    expect(provider?.metadata.mossRole).toBe("provider-config");

    const memoryEntry = index.get(`moss:memory:${MOSS_STARTER_MEMORY_NAME}`);
    expect(memoryEntry?.metadata.mossRole).toBe("memory-entry");
    expect(memoryEntry?.metadata.entryName).toBe(`${MOSS_STARTER_MEMORY_NAME}.md`);
    expect(memoryEntry?.metadata.projectionUnit).toBe("file");

    const skill = index.get(`moss:skill:${MOSS_STARTER_SKILL_NAME}`);
    expect(skill?.enabled).toBe(true);
    expect(skill?.metadata.projectionUnit).toBe("directory");
    expect(skill?.path.endsWith("SKILL.md")).toBe(true);

    const mcp = index.get("moss:mcp:config");
    expect(mcp?.kind).toBe("mcp");
    expect(mcp?.metadata.serverCount).toBe(0);

    const hook = index.get(`moss:hook:${MOSS_STARTER_HOOK_NAME}`);
    expect(hook?.enabled).toBe(true);
    expect(hook?.metadata.event).toBe(MOSS_STARTER_HOOK_EVENT);
    expect(hook?.metadata.command).toBe(MOSS_STARTER_HOOK_COMMAND);
    // Bootstrap trusts its own managed starter hook at the known hash.
    const expectedHash = computeHookTrustHash({
      command: MOSS_STARTER_HOOK_COMMAND,
      event: MOSS_STARTER_HOOK_EVENT,
    });
    expect(hook?.metadata.trustHash).toBe(expectedHash);
    expect(hook?.metadata.trustedHash).toBe(expectedHash);
    expect(hook?.metadata.trustState).toBe("trusted");

    // Every discovered path is project-relative.
    for (const resource of resources) {
      expect(resource.path.startsWith("/")).toBe(false);
    }
  });

  it("imports a formal .codex-plugin manifest and decomposes every plugin component", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });
    const pluginRoot = join(getMossSourceLayout(workspace).pluginsRoot, "research-kit");
    await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", "research"), { recursive: true });
    await mkdir(join(pluginRoot, "agents"), { recursive: true });
    await mkdir(join(pluginRoot, "assets"), { recursive: true });
    await writeFile(
      join(pluginRoot, "skills", "research", "SKILL.md"),
      "---\nname: research\ndescription: Research helper.\n---\n# Research\n",
      "utf8",
    );
    await writeFile(join(pluginRoot, "agents", "researcher.md"), "# Researcher\n", "utf8");
    await writeFile(
      join(pluginRoot, ".mcp.json"),
      '{"mcpServers":{"search":{"command":"search"}}}\n',
    );
    await writeFile(
      join(pluginRoot, ".app.json"),
      '{"apps":{"docs":{"id":"docs","category":"Productivity"}}}\n',
    );
    await writeFile(join(pluginRoot, "hooks.json"), '{"sessionStart":[]}\n');
    await writeFile(join(pluginRoot, "assets", "icon.png"), "png", "utf8");
    await writeFile(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "research-kit",
        version: "1.2.3",
        description: "Research workspace tools.",
        author: { name: "Moss", email: "moss@example.com" },
        interface: {
          displayName: "Research Kit",
          shortDescription: "Research helpers",
          longDescription: "Research helpers for a workspace.",
          developerName: "Moss",
          category: "Productivity",
          capabilities: ["Research"],
          defaultPrompt: ["Run research"],
          composerIcon: "./assets/icon.png",
        },
        skills: "./skills/",
        mcpServers: "./.mcp.json",
        apps: "./.app.json",
      }),
    );

    const plugin = (await discoverMossSourceResources(workspace)).find(
      (resource) => resource.kind === "plugin",
    );
    const ir = plugin?.metadata.plugin as {
      manifestFormat: string;
      validation: { ok: boolean };
      components: Array<{ kind: string; sourcePath?: string }>;
      marketplacePolicy: { installation: string; authentication: string; category: string };
    };

    expect(plugin).toMatchObject({
      id: "moss:plugin:research-kit",
      kind: "plugin",
      name: "research-kit",
      enabled: true,
      metadata: { mossRole: "plugin", manifestFormat: "formal" },
    });
    expect(ir.validation.ok).toBe(true);
    expect(ir.components.map((component) => component.kind)).toEqual([
      "skill",
      "mcp",
      "app",
      "asset",
    ]);
    expect(ir.components.find((component) => component.kind === "skill")?.sourcePath).toBe(
      "./skills/research",
    );
    expect(ir.marketplacePolicy).toEqual({
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
      category: "Productivity",
    });
    expect(() =>
      Schema.decodeUnknownSync(MossPluginIRSchema)(plugin?.metadata.plugin),
    ).not.toThrow();
  });

  it("keeps legacy .moss plugin.json compatible while retaining component decomposition", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });
    const pluginRoot = join(getMossSourceLayout(workspace).pluginsRoot, "writer");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({
        name: "writer",
        description: "Legacy writer.",
        enabled: true,
        skills: [{ name: "writer-skill", path: "/tmp/writer/SKILL.md" }],
        mcpServers: ["docs-mcp"],
        hooks: [{ name: "on-save", event: "Stop" }],
        apps: [{ id: "docs", name: "Docs" }],
        subagents: [{ name: "editor", path: "./agents/editor.md" }],
        assets: ["./assets/logo.png"],
        permissions: { allow: ["mcp:docs-mcp"] },
      }),
    );

    const plugin = (await discoverMossSourceResources(workspace)).find(
      (resource) => resource.kind === "plugin",
    );
    const ir = plugin?.metadata.plugin as {
      manifestFormat: string;
      validation: { ok: boolean };
      components: Array<{ kind: string; name: string; enabled: boolean }>;
    };

    expect(plugin?.enabled).toBe(true);
    expect(ir.manifestFormat).toBe("legacy");
    expect(ir.validation.ok).toBe(true);
    expect(ir.components.map((component) => component.kind)).toEqual([
      "skill",
      "mcp",
      "hook",
      "app",
      "subagent",
      "asset",
      "permission",
    ]);
    expect(ir.components.find((component) => component.kind === "skill")?.enabled).toBe(false);
    expect(ir.components.find((component) => component.kind === "mcp")?.name).toBe("docs-mcp");
  });

  it("does not make a formal manifest with plugin-creator-invalid hooks executable", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });
    const pluginRoot = join(getMossSourceLayout(workspace).pluginsRoot, "invalid-hooks");
    await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "invalid-hooks",
        version: "1.0.0",
        description: "Invalid hook manifest.",
        author: { name: "Moss" },
        interface: {
          displayName: "Invalid Hooks",
          shortDescription: "Invalid",
          longDescription: "Invalid hook fixture.",
          developerName: "Moss",
          category: "Productivity",
          capabilities: ["Safety"],
          defaultPrompt: ["Review hooks"],
        },
        hooks: "./hooks.json",
      }),
    );

    const plugin = (await discoverMossSourceResources(workspace)).find(
      (resource) => resource.kind === "plugin",
    );
    const ir = plugin?.metadata.plugin as {
      enabled: boolean;
      validation: { ok: boolean; errors: Array<{ code: string }> };
    };

    expect(plugin?.enabled).toBe(false);
    expect(ir.enabled).toBe(false);
    expect(ir.validation.ok).toBe(false);
    expect(ir.validation.errors.map((error) => error.code)).toContain("manifest-unsupported-field");
  });

  it("does not follow a formal plugin component symlink outside its root", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });
    const layout = getMossSourceLayout(workspace);
    const externalSkills = await mkdtemp(join(OS.tmpdir(), "moss-external-plugin-skills-"));
    tempDirs.push(externalSkills);
    await mkdir(join(externalSkills, "research"), { recursive: true });
    await writeFile(
      join(externalSkills, "research", "SKILL.md"),
      "---\nname: research\ndescription: External.\n---\nExternal\n",
      "utf8",
    );

    const pluginRoot = join(layout.pluginsRoot, "symlink-kit");
    await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
    await symlink(
      externalSkills,
      join(pluginRoot, "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "symlink-kit",
        version: "1.0.0",
        description: "Symlink fixture.",
        author: { name: "Moss" },
        interface: {
          displayName: "Symlink Kit",
          shortDescription: "Symlink",
          longDescription: "Symlink fixture.",
          developerName: "Moss",
          category: "Productivity",
          capabilities: ["Inspection"],
          defaultPrompt: ["Inspect"],
        },
        skills: "./skills/",
      }),
    );

    const plugin = (await discoverMossSourceResources(workspace)).find(
      (resource) => resource.kind === "plugin",
    );
    const ir = plugin?.metadata.plugin as {
      enabled: boolean;
      validation: { errors: Array<{ code: string }> };
      components: Array<{ kind: string; enabled: boolean }>;
    };
    expect(ir.enabled).toBe(false);
    expect(ir.validation.errors.map((error) => error.code)).toContain(
      "manifest-component-path-unsafe",
    );
    expect(ir.components.find((component) => component.kind === "skill")?.enabled).toBe(false);
  });

  it("rejects a canonical .moss/plugins root symlink that resolves outside the workspace", async () => {
    const workspace = await makeTempWorkspace();
    const externalRoot = await mkdtemp(join(OS.tmpdir(), "moss-external-plugins-root-"));
    tempDirs.push(externalRoot);
    await mkdir(join(externalRoot, "outside-kit"), { recursive: true });
    await writeFile(
      join(externalRoot, "outside-kit", "plugin.json"),
      JSON.stringify({ name: "outside-kit", description: "External plugin." }),
    );
    const layout = getMossSourceLayout(workspace);
    await mkdir(join(workspace, ".moss"), { recursive: true });
    await symlink(
      externalRoot,
      layout.pluginsRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    const resources = await discoverMossSourceResources(workspace);
    expect(resources.filter((resource) => resource.kind === "plugin")).toEqual([]);
  });

  it("inherits nested companion enabled and quarantine gates instead of trusting the map wrapper", async () => {
    const workspace = await makeTempWorkspace();
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "nested-gate-kit");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "nested-gate-kit",
        description: "Nested companion gate fixture.",
        mcpServers: "./mcp.json",
      }),
    );
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: {
            definition: {
              command: "docs-server",
              enabled: true,
              quarantine: true,
            },
          },
        },
      }),
    );

    const plugin = (await discoverMossSourceResources(workspace)).find(
      (resource) => resource.kind === "plugin",
    )?.metadata.plugin as {
      components: Array<{
        kind: string;
        name: string;
        enabled: boolean;
        metadata: Record<string, unknown>;
      }>;
    };
    const mcp = plugin.components.find((component) => component.kind === "mcp");
    expect(mcp).toMatchObject({
      name: "docs",
      enabled: false,
      metadata: { parentQuarantined: true },
    });
  });

  it("inherits disabled and quarantined parent state into expanded plugin children", async () => {
    const workspace = await makeTempWorkspace();
    const pluginRoot = join(getMossSourceLayout(workspace).pluginsRoot, "parent-gates");
    await mkdir(join(pluginRoot, "skills", "child"), { recursive: true });
    await writeFile(
      join(pluginRoot, "skills", "child", "SKILL.md"),
      "---\nname: child\ndescription: Child\n---\nChild.\n",
      "utf8",
    );
    await writeFile(join(pluginRoot, "hooks.json"), '{"hooks":{"stop":{"command":"echo stop"}}}\n');
    await writeFile(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({
        name: "parent-gates",
        description: "Parent gate fixture.",
        skills: [{ name: "skill-bundle", path: "./skills", enabled: false }],
        hooks: [{ name: "hook-bundle", path: "./hooks.json", quarantine: true }],
      }),
      "utf8",
    );

    const plugin = (await discoverMossSourceResources(workspace)).find(
      (resource) => resource.kind === "plugin",
    )?.metadata.plugin as {
      components: Array<{
        kind: string;
        name: string;
        enabled: boolean;
        metadata: Record<string, unknown>;
      }>;
    };

    expect(plugin.components.find((component) => component.kind === "skill")).toMatchObject({
      name: "child",
      enabled: false,
      metadata: { parentEnabled: false },
    });
    expect(plugin.components.find((component) => component.kind === "hook")).toMatchObject({
      enabled: false,
      metadata: { parentEnabled: false, parentQuarantined: true },
    });
  });

  it("rejects an external alias at the Skill file path in an otherwise-contained plugin directory", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });
    const externalSkill = await mkdtemp(join(OS.tmpdir(), "moss-external-skill-file-"));
    tempDirs.push(externalSkill);
    await writeFile(
      join(externalSkill, "SKILL.md"),
      "---\nname: escaped\ndescription: External.\n---\nExternal\n",
      "utf8",
    );

    const pluginRoot = join(getMossSourceLayout(workspace).pluginsRoot, "file-symlink-kit");
    await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", "escaped"), { recursive: true });
    await symlink(
      // A Windows junction is deliberately an invalid file entry. It exercises
      // rejection only; positive file projection tests never use this alias.
      process.platform === "win32" ? externalSkill : join(externalSkill, "SKILL.md"),
      join(pluginRoot, "skills", "escaped", "SKILL.md"),
      process.platform === "win32" ? "junction" : "file",
    );
    await writeFile(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "file-symlink-kit",
        version: "1.0.0",
        description: "Skill file symlink fixture.",
        author: { name: "Moss" },
        interface: {
          displayName: "File Symlink Kit",
          shortDescription: "File symlink",
          longDescription: "Skill file symlink fixture.",
          developerName: "Moss",
          category: "Safety",
          capabilities: ["Inspection"],
          defaultPrompt: ["Inspect"],
        },
        skills: "./skills",
      }),
    );

    const plugin = (await discoverMossSourceResources(workspace)).find(
      (resource) => resource.kind === "plugin",
    )?.metadata.plugin as { validation: { ok: boolean; errors: Array<{ code: string }> } };
    expect(plugin.validation.ok).toBe(false);
    expect(plugin.validation.errors.map((error) => error.code)).toContain(
      "manifest-skill-path-unsafe",
    );
  });

  it("rejects a skill frontmatter name that is not one safe path segment", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });
    const pluginRoot = join(getMossSourceLayout(workspace).pluginsRoot, "unsafe-name-kit");
    await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", "safe-directory"), { recursive: true });
    await writeFile(
      join(pluginRoot, "skills", "safe-directory", "SKILL.md"),
      "---\nname: ../escape\ndescription: Must not become a target path.\n---\nUnsafe\n",
      "utf8",
    );
    await writeFile(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "unsafe-name-kit",
        version: "1.0.0",
        description: "Unsafe component name fixture.",
        author: { name: "Moss" },
        interface: {
          displayName: "Unsafe Name Kit",
          shortDescription: "Unsafe",
          longDescription: "Unsafe component name fixture.",
          developerName: "Moss",
          category: "Productivity",
          capabilities: ["Safety"],
          defaultPrompt: ["Inspect"],
        },
        skills: "./skills",
      }),
    );

    const pluginResource = (await discoverMossSourceResources(workspace)).find(
      (resource) => resource.kind === "plugin",
    );
    const plugin = pluginResource?.metadata.plugin as {
      validation: { ok: boolean; errors: Array<{ code: string }> };
      components: Array<{ kind: string; name: string; enabled: boolean }>;
    };

    expect(plugin.validation.ok).toBe(false);
    expect(plugin.validation.errors.map((error) => error.code)).toContain(
      "manifest-component-name-unsafe",
    );
    expect(plugin.components.find((component) => component.kind === "skill")).toMatchObject({
      name: "../escape",
      enabled: false,
    });
  });

  it("rejects inline MCP secret values instead of retaining them in plugin IR", () => {
    const validation = validateMossPluginManifest(
      {
        name: "secret-kit",
        version: "1.0.0",
        description: "Secret fixture.",
        author: { name: "Moss" },
        interface: {
          displayName: "Secret Kit",
          shortDescription: "Secret",
          longDescription: "Secret fixture.",
          developerName: "Moss",
          category: "Productivity",
          capabilities: ["Safety"],
          defaultPrompt: ["Inspect"],
        },
        mcpServers: {
          secret: { command: "secret-server", env: { API_KEY: "plaintext-secret" } },
        },
      },
      { format: "formal", expectedName: "secret-kit" },
    );

    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("manifest-inline-secret");
  });

  it("rejects MCP URL query parameters that inline credential-like values", () => {
    const validation = validateMossPluginManifest(
      {
        name: "url-secret-kit",
        version: "1.0.0",
        description: "URL secret fixture.",
        author: { name: "Moss" },
        interface: {
          displayName: "URL Secret Kit",
          shortDescription: "URL secret",
          longDescription: "URL secret fixture.",
          developerName: "Moss",
          category: "Productivity",
          capabilities: ["Safety"],
          defaultPrompt: ["Inspect"],
        },
        mcpServers: {
          remote: { type: "http", url: "https://mcp.example.test/server?access_token=plaintext" },
        },
      },
      { format: "formal", expectedName: "url-secret-kit" },
    );

    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error) => error.code)).toContain("manifest-inline-secret");
  });

  it("marks disabled skills/hooks and untrusted user hooks", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });
    const layout = getMossSourceLayout(workspace);

    await mkdir(join(layout.skillsRoot, "disabled-skill"), { recursive: true });
    await writeFile(
      join(layout.skillsRoot, "disabled-skill", "SKILL.md"),
      "---\nname: disabled-skill\nenabled: false\n---\nOff.\n",
      "utf8",
    );
    await writeFile(
      join(layout.hooksRoot, "user-hook.md"),
      "---\nname: user-hook\nevent: Stop\ncommand: echo user\n---\nUser hook.\n",
      "utf8",
    );

    const index = byId(await discoverMossSourceResources(workspace));
    expect(index.get("moss:skill:disabled-skill")?.enabled).toBe(false);
    const userHook = index.get("moss:hook:user-hook");
    expect(userHook?.enabled).toBe(true);
    expect(userHook?.metadata.trustState).toBe("untrusted");
    expect(userHook?.metadata.trustedHash).toBeUndefined();
  });

  it("expands MCP servers into one resource each and flags parse errors", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });
    const layout = getMossSourceLayout(workspace);

    await writeFile(
      layout.mcpConfig,
      `${JSON.stringify(
        {
          mcpServers: {
            browser: { command: "browser", args: ["--headless"] },
            search: { url: "https://mcp.example" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const index = byId(await discoverMossSourceResources(workspace));
    expect(index.has("moss:mcp:config")).toBe(false);
    expect(index.get("moss:mcp:browser")?.metadata.serverConfig).toEqual({
      command: "browser",
      args: ["--headless"],
    });
    expect(index.get("moss:mcp:search")?.enabled).toBe(true);

    await writeFile(layout.mcpConfig, "{ not json", "utf8");
    const errorIndex = byId(await discoverMossSourceResources(workspace));
    const errorResource = errorIndex.get("moss:mcp:config-error");
    expect(errorResource?.enabled).toBe(false);
    expect(typeof errorResource?.metadata.error).toBe("string");
  });

  it("discovers subagents and skips traversal-unsafe entry names", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });
    const layout = getMossSourceLayout(workspace);

    await writeFile(
      join(layout.subagentsRoot, "cleanup-agent.md"),
      "---\nname: cleanup-agent\ndescription: Cleanup\n---\nRun cleanup.\n",
      "utf8",
    );
    // A literal backslash cannot occur in a Windows filename. Use another
    // unsafe single entry there; both separators remain validated below.
    const unsafeName = process.platform === "win32" ? "evil..md" : "evil\\agent.md";
    await writeFile(join(layout.subagentsRoot, unsafeName), "---\nname: evil\n---\n", "utf8");

    const index = byId(await discoverMossSourceResources(workspace));
    expect(index.get("moss:subagent:cleanup-agent")?.kind).toBe("subagent");
    expect(index.has("moss:subagent:evil")).toBe(false);

    expect(isSafeEntryName("fine-name")).toBe(true);
    expect(isSafeEntryName("../escape")).toBe(false);
    expect(isSafeEntryName("a/b")).toBe(false);
    expect(isSafeEntryName("a\\b")).toBe(false);
  });

  it("does not treat tracked plugin or subagent README contracts as resources", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });
    const layout = getMossSourceLayout(workspace);

    await writeFile(join(layout.pluginsRoot, "README.md"), "# Plugin source contract\n", "utf8");
    await writeFile(
      join(layout.subagentsRoot, "README.md"),
      "---\nname: README-agent\ndescription: Documentation only\n---\nNot an agent.\n",
      "utf8",
    );

    const resources = await discoverMossSourceResources(workspace);
    expect(resources.some((resource) => resource.kind === "plugin")).toBe(false);
    expect(resources.some((resource) => resource.id === "moss:subagent:README-agent")).toBe(false);
    expect(resources.some((resource) => resource.path.endsWith("/subagents/README.md"))).toBe(
      false,
    );
  });
});

describe("plugin-creator marketplace validation", () => {
  it("fails closed for formal fields rejected by plugin-creator", () => {
    const validation = validateMossPluginManifest(
      {
        name: "unsafe-plugin",
        version: "1.0.0",
        description: "Unsafe fixture.",
        author: { name: "Moss" },
        interface: {
          displayName: "Unsafe",
          shortDescription: "Unsafe",
          longDescription: "Unsafe fixture.",
          developerName: "Moss",
          category: "Productivity",
          capabilities: ["Inspection"],
          defaultPrompt: ["Inspect"],
        },
        hooks: "./hooks.json",
        permissions: { allow: ["shell"] },
      },
      { format: "formal", expectedName: "unsafe-plugin" },
    );

    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["manifest-unsupported-field"]),
    );
  });

  it("requires local source, installation/authentication policy, and category", () => {
    const validation = validateMossPluginMarketplaceEntry({
      name: "missing-policy",
      source: { source: "remote" },
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "marketplace-source-invalid",
        "marketplace-policy-missing",
        "marketplace-category-missing",
      ]),
    );
  });
});
