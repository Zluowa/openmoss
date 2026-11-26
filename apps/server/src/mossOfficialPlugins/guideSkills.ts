// FILE: guideSkills.ts
// Purpose: Keeps Moss Guide's skills (`moss-guide` and `moss-plugin-discovery`) in
//          Moss's shared `~/.moss/skills` folder in sync with whether `moss-guide`
//          is installed. A user's own skill of the same name carries no Moss
//          marker and is never overwritten or removed.
// Layer: Server filesystem helper (async fs only)
// Exports: mossGuideSkillFile, syncMossGuideSkills

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  MOSS_GUIDE_SKILLS,
  MOSS_GUIDE_SKILL_MARKER,
  type MossGuidePluginSkillSpec,
  mossGuideSkillMarkdown,
} from "@moss/shared/mossGuidePlugin";

export function mossGuideSkillFile(skillsDir: string, skill: MossGuidePluginSkillSpec): string {
  return nodePath.join(skillsDir, skill.name, "SKILL.md");
}

export async function syncMossGuideSkills(skillsDir: string, installed: boolean): Promise<void> {
  for (const skill of MOSS_GUIDE_SKILLS) {
    const file = mossGuideSkillFile(skillsDir, skill);
    const dir = nodePath.dirname(file);
    const current = await fs.readFile(file, "utf8").catch(() => null);
    const ours = current !== null && current.includes(MOSS_GUIDE_SKILL_MARKER);
    if (installed) {
      const contents = mossGuideSkillMarkdown(skill);
      if (current === contents || (current !== null && !ours)) continue;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, contents, "utf8");
    } else if (ours) {
      await fs.rm(file, { force: true });
      // Leave the directory intact if the user added files of their own inside it.
      await fs.rmdir(dir).catch(() => undefined);
    }
  }
}
