import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRejectedFileAlias } from "../../../../scripts/fixtures/filesystem-links.ts";

import {
  discoverMossPluginCatalog,
  isMossPluginMarketplacePath,
  readMossPluginDetail,
} from "./pluginsCatalog.ts";

describe("pluginsCatalog", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "t3-moss-plugins-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("discovers Moss plugin manifests as an installed marketplace", async () => {
    const pluginDir = join(workspace, ".moss", "plugins", "analytics");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify(
        {
          name: "analytics",
          version: "1.2.3",
          description: "Analyze local project data.",
          enabled: true,
          interface: {
            displayName: "Analytics",
            category: "Data",
            defaultPrompt: ["Analyze this workspace."],
            logoUrl: "https://example.com/analytics.svg",
          },
          mcpServers: ["filesystem"],
        },
        null,
        2,
      ),
    );

    const catalog = await discoverMossPluginCatalog({ cwd: workspace });

    expect(catalog.loadErrors).toEqual([]);
    expect(catalog.marketplace?.name).toBe("Moss");
    expect(catalog.marketplace?.path).toBe(join(workspace, ".moss", "plugins"));
    expect(catalog.marketplace?.plugins).toHaveLength(1);
    expect(catalog.marketplace?.plugins[0]).toMatchObject({
      name: "analytics",
      version: "1.2.3",
      localVersion: "1.2.3",
      availability: "AVAILABLE",
      installed: true,
      enabled: true,
      installPolicy: "INSTALLED_BY_DEFAULT",
      authPolicy: "ON_USE",
      interface: {
        displayName: "Analytics",
        category: "Data",
        logoUrl: "https://example.com/analytics.svg",
      },
    });
  });

  it("reads Moss plugin detail from the marketplace path", async () => {
    const marketplacePath = join(workspace, ".moss", "plugins");
    const pluginDir = join(marketplacePath, "writer");
    const skillDir = join(pluginDir, "skills", "writer-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: writer-skill\ndescription: Draft content.\n---\n# Writer\n",
    );
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "writer",
        description: "Draft content.",
        apps: [
          {
            id: "docs",
            name: "Docs",
            description: null,
            installUrl: null,
            category: null,
          },
        ],
        skills: [{ name: "writer-skill", path: "./skills/writer-skill" }],
        mcpServers: ["docs-mcp"],
      }),
    );

    expect(isMossPluginMarketplacePath(marketplacePath)).toBe(true);
    const detail = await readMossPluginDetail({ marketplacePath, pluginName: "writer" });

    expect(detail.marketplaceName).toBe("Moss");
    expect(detail.summary.source).toEqual({
      type: "local",
      path: join(pluginDir, "plugin.json"),
    });
    expect(detail.apps).toEqual([
      {
        id: "docs",
        name: "Docs",
        description: null,
        installUrl: null,
        category: null,
      },
    ]);
    expect(detail.skills[0]).toMatchObject({ name: "writer-skill", scope: "moss" });
    expect(detail.mcpServers).toEqual(["docs-mcp"]);
  });

  it("discovers standard skill directories from formal plugin manifests", async () => {
    const marketplacePath = join(workspace, ".moss", "plugins");
    const pluginDir = join(marketplacePath, "image-tools");
    await mkdir(join(pluginDir, ".codex-plugin"), { recursive: true });
    await mkdir(join(pluginDir, "skills", "image-create"), { recursive: true });
    await writeFile(
      join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "image-tools",
        version: "1.0.0",
        description: "Create images",
        skills: "./skills/",
      }),
    );
    const skillPath = join(pluginDir, "skills", "image-create", "SKILL.md");
    await writeFile(
      skillPath,
      "---\nname: image-create\ndescription: Create an image.\n---\n# Images\n",
    );
    const catalog = await discoverMossPluginCatalog({ cwd: workspace });
    expect(catalog.loadErrors).toEqual([]);
    expect(catalog.marketplace?.plugins[0]?.source).toEqual({
      type: "local",
      path: join(pluginDir, ".codex-plugin", "plugin.json"),
    });
    const detail = await readMossPluginDetail({ marketplacePath, pluginName: "image-tools" });
    expect(detail.skills).toMatchObject([{ name: "image-create", path: skillPath, scope: "moss" }]);
  });

  it("rejects linked manifests and does not read skills escaping a plugin install", async () => {
    const marketplacePath = join(workspace, ".moss", "plugins");
    const pluginDir = join(marketplacePath, "unsafe");
    await mkdir(pluginDir, { recursive: true });
    const outsideManifest = join(workspace, "outside.json");
    await writeFile(outsideManifest, JSON.stringify({ name: "unsafe" }));
    // A Windows junction is a rejection entry here, never a positive manifest target.
    createRejectedFileAlias(outsideManifest, join(pluginDir, "plugin.json"));
    const catalog = await discoverMossPluginCatalog({ cwd: workspace });
    expect(catalog.marketplace).toBeNull();
    expect(catalog.loadErrors[0]?.message).toMatch(/symbolic.link/i);

    await rm(join(pluginDir, "plugin.json"), { recursive: true });
    expect(await readFile(outsideManifest, "utf8")).toBe(JSON.stringify({ name: "unsafe" }));
    const outsideSkills = join(workspace, "outside-skills");
    await mkdir(join(outsideSkills, "secret"), { recursive: true });
    await writeFile(join(outsideSkills, "secret", "SKILL.md"), "---\nname: secret\n---\nPrivate\n");
    await symlink(
      outsideSkills,
      join(pluginDir, "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "unsafe",
        skills: "./skills/",
      }),
    );
    const detail = await readMossPluginDetail({ marketplacePath, pluginName: "unsafe" });
    expect(detail.skills).toEqual([]);
  });
});
