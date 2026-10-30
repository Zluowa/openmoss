// FILE: mossSkillCreatorSkill.ts
// Purpose: The skill behind Customize's Create skill for every CLI. A CLI that
//          ships its own skill-creator (Codex) keeps it; this portable copy
//          writes new skills where every agent Moss runs can use them.
// Layer: Provider discovery content
// Exports: MOSS_SKILL_CREATOR_SKILL

export const MOSS_SKILL_CREATOR_SKILL = `---
name: skill-creator
description: Create or update a skill (a SKILL.md with optional scripts, references, and assets) that Codex, Claude, and every other agent in Moss can use. Use when the user asks to make, write, or improve a skill.
---

# Moss Skill Creator

Create a working skill from the user's request. Ask only about decisions that change the result.

## Choose where it lives

- Personal (default): a new folder beside the folder that holds this file. That directory is Moss's shared skills folder, so every agent Moss runs can use what is saved there.
- Project: \`<repository>/.moss/skills/<skill-name>/\` when the user wants the skill to travel with one repository.

Do not write into one CLI's own skills folder (such as \`~/.codex/skills\` or \`~/.claude/skills\`) unless the user asks for it: only that agent would see the skill.

## Write the skill

1. Pick a short lowercase hyphenated name that is not already used in the target folder. To update an existing skill, edit it in place instead.
2. Create \`<skill-name>/SKILL.md\` that starts with YAML frontmatter:

   \`\`\`markdown
   ---
   name: <skill-name>
   description: <what the skill does and exactly when to use it>
   ---
   \`\`\`

   Agents decide whether to load a skill from its description alone, so name the tasks, inputs, and situations it covers.
3. Below the frontmatter, write concise imperative instructions: the steps, the checks that prove the work succeeded, and the mistakes to avoid. Keep SKILL.md under about 500 lines; move long reference material into \`references/\` and link to it.
4. Put reusable code in \`scripts/\` and templates or other files the output needs in \`assets/\`. Reference each one from SKILL.md with a relative path.
5. Never embed API keys, tokens, passwords, or account identifiers. Refer to environment variables or the service's own sign-in flow instead.

## Check and hand off

1. Re-read SKILL.md as an agent seeing it for the first time: the frontmatter parses, the description says when to use the skill, and every referenced file exists.
2. Run any scripts on a small, safe input and fix what fails.
3. Tell the user where the skill was saved and how to use it: mention it in the composer, or ask for the task it describes. Moss lists it under Plugins › Skills.
`;
