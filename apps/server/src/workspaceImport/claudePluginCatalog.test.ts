// FILE: claudePluginCatalog.test.ts
// Purpose: Claude Code's own plugin marketplace catalog is not a plugin the person has
//          (WALK-5 P-4): a Claude Code with nothing of the person's offers nothing to import.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverImportResources } from "./resources";

const dirs: string[] = [];

async function claudeHomeWith(files: Record<string, string>): Promise<string> {
  const home = await fs.mkdtemp(nodePath.join(os.tmpdir(), "moss-claude-catalog-"));
  dirs.push(home);
  for (const [relative, body] of Object.entries(files)) {
    const path = nodePath.join(home, ".claude", ...relative.split("/"));
    await fs.mkdir(nodePath.dirname(path), { recursive: true });
    await fs.writeFile(path, body);
  }
  return home;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// WALK-5 P-4: the profile the walker used had run Claude Code, which fills plugins/ with its own
// marketplace catalog; main counted those files as plugins and offered Claude Code for import.
describe("WALK-5 P-4: Claude Code plugin catalog", () => {
  const catalog = {
    "plugins/known_marketplaces.json": "{}",
    "plugins/installed_plugins.json": '{"plugins":{}}',
    "plugins/config.json": '{"repositories":{}}',
    "plugins/marketplaces/claude-plugins-official/README.md": "# catalog",
    "plugins/marketplaces/claude-plugins-official/plugins/example/plugin.json": "{}",
  };

  it.each([true, false])(
    "counts nothing for the catalog alone (countOnly %s)",
    async (countOnly) => {
      const homeDir = await claudeHomeWith(catalog);
      const inventory = await discoverImportResources({
        source: "claude",
        homeDir,
        platform: process.platform,
        env: {},
        countOnly,
      });
      expect(inventory.counts.plugins).toBe(0);
      expect(inventory.resources.filter((resource) => resource.category === "plugins")).toEqual([]);
    },
  );

  it("still finds a plugin the person installed", async () => {
    const homeDir = await claudeHomeWith({
      ...catalog,
      "plugins/cache/acme/tool/plugin.json": "{}",
    });
    const inventory = await discoverImportResources({
      source: "claude",
      homeDir,
      platform: process.platform,
      env: {},
      countOnly: true,
    });
    expect(inventory.counts.plugins).toBe(1);
  });
});
