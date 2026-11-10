import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { syncMossServiceSkills } from "./serviceSkills.ts";

let skillsDir: string;

beforeEach(async () => {
  skillsDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "moss-service-skills-"));
});

afterEach(async () => {
  await fs.rm(skillsDir, { recursive: true, force: true });
});

const read = (name: string) =>
  fs.readFile(nodePath.join(skillsDir, name, "SKILL.md"), "utf8").catch(() => null);

describe("syncMossServiceSkills", () => {
  it("writes the skills of installed plugins and removes them on uninstall", async () => {
    await syncMossServiceSkills(skillsDir, new Set(["amap", "taobao"]));
    expect(await read("amap-maps")).toContain("name: amap-maps");
    expect(await read("taobao-shopping")).toContain("mcporter");
    expect(await read("didi-ride")).toBeNull();

    await syncMossServiceSkills(skillsDir, new Set(["taobao"]));
    expect(await read("amap-maps")).toBeNull();
    await expect(fs.stat(nodePath.join(skillsDir, "amap-maps"))).rejects.toThrow();
    expect(await read("taobao-shopping")).not.toBeNull();
  });

  it("never overwrites or deletes a user's own skill of the same name", async () => {
    const own = "---\nname: didi-ride\ndescription: mine\n---\nMy own notes.\n";
    await fs.mkdir(nodePath.join(skillsDir, "didi-ride"), { recursive: true });
    await fs.writeFile(nodePath.join(skillsDir, "didi-ride", "SKILL.md"), own);

    await syncMossServiceSkills(skillsDir, new Set(["didi"]));
    expect(await read("didi-ride")).toBe(own);
    await syncMossServiceSkills(skillsDir, new Set());
    expect(await read("didi-ride")).toBe(own);
  });

  it("keeps a folder the user added files to", async () => {
    await syncMossServiceSkills(skillsDir, new Set(["amap"]));
    await fs.writeFile(nodePath.join(skillsDir, "amap-maps", "notes.md"), "mine");
    await syncMossServiceSkills(skillsDir, new Set());
    expect(await read("amap-maps")).toBeNull();
    expect(await fs.readFile(nodePath.join(skillsDir, "amap-maps", "notes.md"), "utf8")).toBe(
      "mine",
    );
  });
});
