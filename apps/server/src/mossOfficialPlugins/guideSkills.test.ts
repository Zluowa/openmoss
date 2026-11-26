import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MOSS_DEVELOPER_HANDBOOK_REFERENCES,
  MOSS_DEVELOPER_SKILLS,
  MOSS_DEVELOPER_SKILL_MARKER,
} from "@moss/shared/mossDeveloperPlugin";
import { MOSS_GUIDE_SKILLS, MOSS_GUIDE_SKILL_MARKER } from "@moss/shared/mossGuidePlugin";

import {
  mossDeveloperSkillFile,
  mossGuideSkillFile,
  syncMossDeveloperSkills,
  syncMossGuideSkills,
} from "./guideSkills.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "moss-guide-skills-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("syncMossGuideSkills", () => {
  it("installs all moss-guide skills with the official marker and removes them on uninstall", async () => {
    const skillsDir = await makeTempDir();
    await syncMossGuideSkills(skillsDir, true);

    for (const skill of MOSS_GUIDE_SKILLS) {
      const file = mossGuideSkillFile(skillsDir, skill);
      const text = await fs.readFile(file, "utf8");
      expect(text).toContain(`name: ${skill.name}`);
      expect(text).toContain(MOSS_GUIDE_SKILL_MARKER);
    }

    await syncMossGuideSkills(skillsDir, false);
    for (const skill of MOSS_GUIDE_SKILLS) {
      const file = mossGuideSkillFile(skillsDir, skill);
      await expect(fs.stat(file)).rejects.toThrow();
    }
  });

  it("never overwrites or deletes a user-authored skill lacking the Moss official marker", async () => {
    const skillsDir = await makeTempDir();
    const customSkill = MOSS_GUIDE_SKILLS[0]!;
    const customFile = mossGuideSkillFile(skillsDir, customSkill);
    await fs.mkdir(nodePath.dirname(customFile), { recursive: true });
    await fs.writeFile(customFile, "# Custom user moss-guide skill\n", "utf8");

    await syncMossGuideSkills(skillsDir, true);
    expect(await fs.readFile(customFile, "utf8")).toBe("# Custom user moss-guide skill\n");

    await syncMossGuideSkills(skillsDir, false);
    expect(await fs.readFile(customFile, "utf8")).toBe("# Custom user moss-guide skill\n");
    const discoveryFile = mossGuideSkillFile(skillsDir, MOSS_GUIDE_SKILLS[1]!);
    await expect(fs.stat(discoveryFile)).rejects.toThrow();
  });

  it("installs moss-developer skill + handbook references and removes them cleanly on uninstall", async () => {
    const skillsDir = await makeTempDir();
    await syncMossDeveloperSkills(skillsDir, true);

    const skill = MOSS_DEVELOPER_SKILLS[0]!;
    const file = mossDeveloperSkillFile(skillsDir, skill);
    const text = await fs.readFile(file, "utf8");
    expect(text).toContain(`name: ${skill.name}`);
    expect(text).toContain(MOSS_DEVELOPER_SKILL_MARKER);

    for (const ref of MOSS_DEVELOPER_HANDBOOK_REFERENCES) {
      const refFile = nodePath.join(nodePath.dirname(file), ...ref.relativePath.split("/"));
      expect(await fs.readFile(refFile, "utf8")).toContain(MOSS_DEVELOPER_SKILL_MARKER);
    }

    await syncMossDeveloperSkills(skillsDir, false);
    await expect(fs.stat(file)).rejects.toThrow();
    for (const ref of MOSS_DEVELOPER_HANDBOOK_REFERENCES) {
      const refFile = nodePath.join(nodePath.dirname(file), ...ref.relativePath.split("/"));
      await expect(fs.stat(refFile)).rejects.toThrow();
    }
  });
});
