import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMossResource,
  deleteMossResource,
  slugifyResourceName,
  updateMossResource,
} from "./mossCreateResource.ts";

describe("slugifyResourceName", () => {
  it("produces a filesystem-safe slug", () => {
    expect(slugifyResourceName("My Cool Skill!")).toBe("my-cool-skill");
    expect(slugifyResourceName("  spaced  ")).toBe("spaced");
  });
});

describe("createMossResource", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "t3-moss-create-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("writes a canonical SKILL.md with frontmatter", async () => {
    const result = await createMossResource({
      kind: "skill",
      cwd: workspace,
      name: "Release Notes",
      description: "Draft release notes.",
    });
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(workspace, ".moss", "skills", "release-notes", "SKILL.md"));
    const body = await readFile(result.path, "utf8");
    expect(body).toContain("name: Release Notes");
    expect(body).toContain("description: Draft release notes.");
    expect(body).toContain("enabled: true");
  });

  it("does not overwrite an existing skill", async () => {
    await createMossResource({ kind: "skill", cwd: workspace, name: "dup" });
    const second = await createMossResource({ kind: "skill", cwd: workspace, name: "dup" });
    expect(second.created).toBe(false);
  });

  it("merges an MCP server into the canonical config without clobbering existing ones", async () => {
    await mkdir(join(workspace, ".moss", "mcp"), { recursive: true });
    await writeFile(
      join(workspace, ".moss", "mcp", "config.json"),
      JSON.stringify({ mcpServers: { existing: { command: "keep" } } }),
    );
    const result = await createMossResource({
      kind: "mcp",
      cwd: workspace,
      name: "fs",
      command: "npx",
      args: ["-y", "server"],
    });
    expect(result.created).toBe(true);
    const config = JSON.parse(await readFile(result.path, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.existing).toEqual({ command: "keep" });
    expect(config.mcpServers.fs).toEqual({ command: "npx", args: ["-y", "server"] });
  });

  it("rejects an MCP server with no command or url", async () => {
    await expect(createMossResource({ kind: "mcp", cwd: workspace, name: "bad" })).rejects.toThrow(
      /command or a url/,
    );
  });

  it("seeds a plugin manifest under .moss/plugins", async () => {
    const result = await createMossResource({
      kind: "plugin",
      cwd: workspace,
      name: "My Plugin",
      description: "does things",
    });
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(workspace, ".moss", "plugins", "my-plugin", "plugin.json"));
    const manifest = JSON.parse(await readFile(result.path, "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "My Plugin",
      description: "does things",
      enabled: true,
    });
  });

  it("preserves provider plugin metadata in the canonical manifest", async () => {
    const result = await createMossResource({
      kind: "plugin",
      cwd: workspace,
      name: "GitHub",
      description: "Manage GitHub work.",
      provider: "codex",
      plugin: {
        id: "github@openai-curated",
        marketplaceName: "OpenAI",
        marketplacePath: "/tmp/openai-curated",
        sourcePath: "/tmp/openai-curated/github/plugin.json",
        authPolicy: "ON_USE",
        interface: {
          displayName: "GitHub",
          shortDescription: "Use GitHub in chat.",
          longDescription: null,
          developerName: null,
          category: "Developer",
          capabilities: ["issues", "pull requests"],
          websiteUrl: null,
          privacyPolicyUrl: null,
          termsOfServiceUrl: null,
          defaultPrompt: ["Summarize my PRs."],
          brandColor: null,
          composerIcon: null,
          composerIconUrl: null,
          logo: null,
          logoDark: null,
          logoUrl: null,
          logoUrlDark: null,
          screenshots: [],
          screenshotUrls: [],
        },
        apps: [
          {
            id: "github",
            name: "GitHub",
            description: null,
            installUrl: null,
            category: null,
          },
        ],
        skills: [
          {
            name: "gh-fix-ci",
            path: "/tmp/skills/gh-fix-ci/SKILL.md",
            enabled: true,
            scope: "moss",
          },
        ],
        mcpServers: ["github"],
      },
    });

    const manifest = JSON.parse(await readFile(result.path, "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: "github@openai-curated",
      name: "GitHub",
      description: "Manage GitHub work.",
      enabled: true,
      source: "moss-unified-source",
      provider: "codex",
      providerSource: {
        marketplaceName: "OpenAI",
        marketplacePath: "/tmp/openai-curated",
        path: "/tmp/openai-curated/github/plugin.json",
      },
      authPolicy: "ON_USE",
      interface: {
        displayName: "GitHub",
        category: "Developer",
        capabilities: ["issues", "pull requests"],
        defaultPrompt: ["Summarize my PRs."],
      },
      apps: [
        {
          id: "github",
          name: "GitHub",
          description: null,
          installUrl: null,
          category: null,
        },
      ],
      skills: [
        { name: "gh-fix-ci", path: "/tmp/skills/gh-fix-ci/SKILL.md", enabled: true, scope: "moss" },
      ],
      mcpServers: ["github"],
    });
  });
});

describe("deleteMossResource", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "t3-moss-delete-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("removes a canonical skill dir by descriptor path", async () => {
    const created = await createMossResource({ kind: "skill", cwd: workspace, name: "temp-skill" });
    const removed = await deleteMossResource({
      kind: "skill",
      cwd: workspace,
      name: "temp-skill",
      path: created.path,
    });
    expect(removed.removed).toBe(true);
    await expect(readFile(created.path, "utf8")).rejects.toThrow();
  });

  it("removes only the named server from the mcp config", async () => {
    await createMossResource({ kind: "mcp", cwd: workspace, name: "keep", command: "a" });
    await createMossResource({ kind: "mcp", cwd: workspace, name: "drop", command: "b" });
    const removed = await deleteMossResource({ kind: "mcp", cwd: workspace, name: "drop" });
    expect(removed.removed).toBe(true);
    const config = JSON.parse(
      await readFile(join(workspace, ".moss", "mcp", "config.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(config.mcpServers)).toEqual(["keep"]);
  });

  it("refuses to delete outside the Moss canonical root", async () => {
    await expect(
      deleteMossResource({
        kind: "skill",
        cwd: workspace,
        name: "evil",
        path: join(workspace, "some-other-dir", "SKILL.md"),
      }),
    ).rejects.toThrow(/outside the Moss canonical root/);
  });
});

describe("updateMossResource", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "t3-moss-update-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("toggles a canonical plugin manifest", async () => {
    const created = await createMossResource({ kind: "plugin", cwd: workspace, name: "Toggle Me" });

    const result = await updateMossResource({
      kind: "plugin",
      cwd: workspace,
      name: "Toggle Me",
      path: created.path,
      enabled: false,
    });

    expect(result).toMatchObject({
      kind: "plugin",
      name: "Toggle Me",
      updated: true,
      enabled: false,
    });
    const manifest = JSON.parse(await readFile(created.path, "utf8")) as { enabled?: boolean };
    expect(manifest.enabled).toBe(false);
  });

  it("refuses to toggle a plugin outside the canonical Moss root", async () => {
    const outside = join(workspace, "plugin.json");
    await writeFile(outside, JSON.stringify({ name: "bad" }), "utf8");

    await expect(
      updateMossResource({
        kind: "plugin",
        cwd: workspace,
        name: "bad",
        path: outside,
        enabled: false,
      }),
    ).rejects.toThrow("outside the Moss canonical plugins root");
  });

  it("toggles a canonical MCP server entry", async () => {
    const created = await createMossResource({
      kind: "mcp",
      cwd: workspace,
      name: "server-a",
      command: "node",
    });

    const result = await updateMossResource({
      kind: "mcp",
      cwd: workspace,
      name: "server-a",
      enabled: false,
    });

    expect(result).toMatchObject({
      kind: "mcp",
      name: "server-a",
      updated: true,
      enabled: false,
    });
    const config = JSON.parse(await readFile(created.path, "utf8")) as {
      mcpServers?: Record<string, { enabled?: boolean }>;
    };
    expect(config.mcpServers?.["server-a"]?.enabled).toBe(false);
  });
});
