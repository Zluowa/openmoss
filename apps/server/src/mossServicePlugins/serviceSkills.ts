// FILE: serviceSkills.ts
// Purpose: Keeps the skills of Moss service plugins in Moss's shared skills
//          folder in step with what is installed: an installed plugin's skill
//          is written (or refreshed), and Moss's copy of every other plugin's
//          skill is removed. A user's own skill of the same name carries no
//          Moss marker and is never touched.
// Layer: Server filesystem helper
// Exports: mossServiceSkillFile, syncMossServiceSkills

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  MOSS_SERVICE_PLUGINS,
  type MossServicePlugin,
  mossServiceSkillMarkdown,
  mossServiceSkillMarker,
} from "@moss/shared/mossServicePlugins";

/** Where a plugin's SKILL.md lives in the shared skills folder. */
export function mossServiceSkillFile(skillsDir: string, plugin: MossServicePlugin): string {
  return nodePath.join(skillsDir, plugin.skill.name, "SKILL.md");
}

export async function syncMossServiceSkills(
  skillsDir: string,
  installed: ReadonlySet<string>,
): Promise<void> {
  for (const plugin of MOSS_SERVICE_PLUGINS) {
    const file = mossServiceSkillFile(skillsDir, plugin);
    const dir = nodePath.dirname(file);
    const current = await fs.readFile(file, "utf8").catch(() => null);
    const ours = current !== null && current.includes(mossServiceSkillMarker(plugin.id));
    if (installed.has(plugin.id)) {
      const contents = mossServiceSkillMarkdown(plugin);
      if (current === contents || (current !== null && !ours)) continue;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, contents, "utf8");
    } else if (ours) {
      await fs.rm(file, { force: true });
      // Leaves the folder when the user added files of their own to it.
      await fs.rmdir(dir).catch(() => undefined);
    }
  }
}
