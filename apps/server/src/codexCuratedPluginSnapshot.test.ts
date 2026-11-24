import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findNewestCuratedPluginSnapshot,
  hasCuratedPluginSnapshot,
  seedCuratedPluginSnapshot,
} from "./codexCuratedPluginSnapshot.ts";

const roots: string[] = [];

async function makeHome(name: string, snapshot?: { sha: string; mtime: Date }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `moss-curated-${name}-`));
  roots.push(root);
  if (snapshot) {
    const marketplace = path.join(root, ".tmp", "plugins", ".agents", "plugins");
    await fs.mkdir(marketplace, { recursive: true });
    await fs.writeFile(path.join(marketplace, "marketplace.json"), `{"name":"${name}"}`);
    await fs.mkdir(path.join(root, ".tmp", "plugins", "plugins", "example"), { recursive: true });
    await fs.writeFile(path.join(root, ".tmp", "plugins", "plugins", "example", "README.md"), name);
    const shaFile = path.join(root, ".tmp", "plugins.sha");
    await fs.writeFile(shaFile, `${snapshot.sha}\n`);
    await fs.utimes(shaFile, snapshot.mtime, snapshot.mtime);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("curated plugin snapshot seeding", () => {
  it("copies the newest snapshot on this computer into a home that has none", async () => {
    const older = await makeHome("older", { sha: "a".repeat(40), mtime: new Date("2026-11-01") });
    const newer = await makeHome("newer", { sha: "b".repeat(40), mtime: new Date("2026-11-09") });
    const empty = await makeHome("empty");

    expect(await findNewestCuratedPluginSnapshot([older, newer, empty])).toBe(path.resolve(newer));
    expect(await hasCuratedPluginSnapshot(empty)).toBe(false);
    expect(await seedCuratedPluginSnapshot(empty, [older, newer, empty])).toBe("seeded");

    expect(await hasCuratedPluginSnapshot(empty)).toBe(true);
    expect(
      await fs.readFile(
        path.join(empty, ".tmp", "plugins", ".agents", "plugins", "marketplace.json"),
        "utf8",
      ),
    ).toBe('{"name":"newer"}');
    expect(await fs.readFile(path.join(empty, ".tmp", "plugins.sha"), "utf8")).toBe(
      `${"b".repeat(40)}\n`,
    );
    // No staging folder is left behind.
    expect((await fs.readdir(path.join(empty, ".tmp"))).sort()).toEqual(["plugins", "plugins.sha"]);
  });

  it("leaves a home that already has a snapshot alone", async () => {
    const own = await makeHome("own", { sha: "c".repeat(40), mtime: new Date("2026-10-01") });
    const newer = await makeHome("newer", { sha: "d".repeat(40), mtime: new Date("2026-11-20") });
    expect(await seedCuratedPluginSnapshot(own, [newer])).toBe("present");
    expect(await fs.readFile(path.join(own, ".tmp", "plugins.sha"), "utf8")).toBe(
      `${"c".repeat(40)}\n`,
    );
  });

  it("says so when no snapshot exists anywhere", async () => {
    const empty = await makeHome("empty");
    const other = await makeHome("other");
    expect(await seedCuratedPluginSnapshot(empty, [empty, other])).toBe("no-source");
    expect(await hasCuratedPluginSnapshot(empty)).toBe(false);
  });
});
