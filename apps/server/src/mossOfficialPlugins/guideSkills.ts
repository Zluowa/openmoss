// FILE: guideSkills.ts
// Purpose: Keeps Moss official plugins' skills (`moss-guide`, `moss-plugin-discovery`,
//          and `moss-developer`) in Moss's shared `~/.moss/skills` folder in sync
//          with installation state. User-authored skills of the same name carry
//          no Moss marker and are never overwritten or removed.
// Layer: Server filesystem helper (async fs only)
// Exports: mossGuideSkillFile, syncMossGuideSkills,
//          mossDeveloperSkillFile, syncMossDeveloperSkills

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  MOSS_DEVELOPER_HANDBOOK_REFERENCES,
  MOSS_DEVELOPER_SKILLS,
  MOSS_DEVELOPER_SKILL_MARKER,
  type MossDeveloperSkillSpec,
  mossDeveloperSkillMarkdown,
} from "@moss/shared/mossDeveloperPlugin";
import {
  MOSS_GUIDE_SKILLS,
  MOSS_GUIDE_SKILL_MARKER,
  type MossGuidePluginSkillSpec,
  mossGuideSkillMarkdown,
} from "@moss/shared/mossGuidePlugin";

export function mossGuideSkillFile(skillsDir: string, skill: MossGuidePluginSkillSpec): string {
  return nodePath.join(skillsDir, skill.name, "SKILL.md");
}

export function mossDeveloperSkillFile(skillsDir: string, skill: MossDeveloperSkillSpec): string {
  return nodePath.join(skillsDir, skill.name, "SKILL.md");
}

async function syncMarkedSkillSet<TSkill extends { readonly name: string }>(input: {
  readonly skillsDir: string;
  readonly skills: ReadonlyArray<TSkill>;
  readonly marker: string;
  readonly renderMarkdown: (skill: TSkill) => string;
  readonly installed: boolean;
  readonly references?: ReadonlyArray<{ readonly relativePath: string; readonly body: string }>;
}): Promise<void> {
  for (const skill of input.skills) {
    const file = nodePath.join(input.skillsDir, skill.name, "SKILL.md");
    const dir = nodePath.dirname(file);
    const current = await fs.readFile(file, "utf8").catch(() => null);
    const ours = current !== null && current.includes(input.marker);
    if (input.installed) {
      if (current !== null && !ours) continue;
      const contents = input.renderMarkdown(skill);
      if (current !== contents) {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, contents, "utf8");
      }
      if (input.references) {
        for (const ref of input.references) {
          const refFile = nodePath.join(dir, ...ref.relativePath.split("/"));
          const refContents = `${input.marker}\n\n${ref.body.trim()}\n`;
          const existingRef = await fs.readFile(refFile, "utf8").catch(() => null);
          if (existingRef === refContents) continue;
          if (existingRef !== null && !existingRef.includes(input.marker)) continue;
          await fs.mkdir(nodePath.dirname(refFile), { recursive: true });
          await fs.writeFile(refFile, refContents, "utf8");
        }
      }
    } else if (ours) {
      await fs.rm(file, { force: true });
      if (input.references) {
        for (const ref of input.references) {
          const refFile = nodePath.join(dir, ...ref.relativePath.split("/"));
          const existingRef = await fs.readFile(refFile, "utf8").catch(() => null);
          if (existingRef !== null && existingRef.includes(input.marker)) {
            await fs.rm(refFile, { force: true });
            await fs.rmdir(nodePath.dirname(refFile)).catch(() => undefined);
          }
        }
      }
      // Leave the directory intact if the user added files of their own inside it.
      await fs.rmdir(dir).catch(() => undefined);
    }
  }
}

export async function syncMossGuideSkills(skillsDir: string, installed: boolean): Promise<void> {
  await syncMarkedSkillSet({
    skillsDir,
    skills: MOSS_GUIDE_SKILLS,
    marker: MOSS_GUIDE_SKILL_MARKER,
    renderMarkdown: mossGuideSkillMarkdown,
    installed,
  });
}

export async function syncMossDeveloperSkills(
  skillsDir: string,
  installed: boolean,
): Promise<void> {
  await syncMarkedSkillSet({
    skillsDir,
    skills: MOSS_DEVELOPER_SKILLS,
    marker: MOSS_DEVELOPER_SKILL_MARKER,
    renderMarkdown: mossDeveloperSkillMarkdown,
    installed,
    references: MOSS_DEVELOPER_HANDBOOK_REFERENCES,
  });
}
