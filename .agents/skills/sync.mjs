// FILE: sync.mjs
// Purpose: Copies every skill in .agents/skills into .claude/skills, where Claude Code reads skills.
// Layer: Agent tooling
// Exports: none (CLI). `node .agents/skills/sync.mjs` writes the copies;
//          `node .agents/skills/sync.mjs --check` exits 1 when a copy is missing, differs or is stale.
// Why: .agents/skills is the one source. Symlinks do not survive a Windows checkout, so
//      Claude Code gets generated copies, and the check keeps them from drifting.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = dirname(fileURLToPath(import.meta.url));
const REPO = join(SOURCE, "..", "..");
const TARGET = join(REPO, ".claude", "skills");
const check = process.argv.includes("--check");

// The public mirror publishes .agents/ but not .claude/ (nor the mirror tool itself), so
// there the copies are made on demand and there is nothing to hold to account.
if (check && !existsSync(join(REPO, "scripts", "public-mirror"))) {
  console.log("Claude skills check skipped: .claude/ is not part of this checkout.");
  process.exit(0);
}

const toPosix = (path) => path.split(sep).join("/");

function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
    else
      throw new Error(`${toPosix(relative(REPO, path))}: skills may hold only folders and files`);
  }
  return files;
}

// The note goes after the frontmatter, which runtimes require on the first line.
function withGeneratedNote(name, text) {
  const note = `<!-- Generated from .agents/skills/${name}/SKILL.md by \`node .agents/skills/sync.mjs\`. Edit the source, then run the sync. -->`;
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  if (!match) throw new Error(`.agents/skills/${name}/SKILL.md: missing frontmatter`);
  return `${match[0]}\n${note}\n${text.slice(match[0].length)}`;
}

const skills = readdirSync(SOURCE, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(SOURCE, entry.name, "SKILL.md")))
  .map((entry) => entry.name)
  .toSorted();

const expected = new Map();
for (const name of skills) {
  for (const file of listFiles(join(SOURCE, name))) {
    const path = toPosix(relative(SOURCE, file));
    const text = readFileSync(file, "utf8");
    expected.set(path, path === `${name}/SKILL.md` ? withGeneratedNote(name, text) : text);
  }
}

const actual = existsSync(TARGET)
  ? listFiles(TARGET).map((file) => toPosix(relative(TARGET, file)))
  : [];
const problems = [];
for (const [path, text] of expected) {
  const file = join(TARGET, path);
  if (!existsSync(file)) problems.push({ path, kind: "missing" });
  else if (readFileSync(file, "utf8") !== text) problems.push({ path, kind: "differs" });
}
for (const path of actual) {
  if (!expected.has(path)) problems.push({ path, kind: "has no source" });
}

if (check) {
  if (problems.length === 0) {
    console.log(`Claude skills match .agents/skills (${skills.length} skills).`);
  } else {
    console.error("Claude skills are out of date. Run `node .agents/skills/sync.mjs` and commit:");
    for (const { path, kind } of problems) console.error(`- .claude/skills/${path}: ${kind}`);
    process.exitCode = 1;
  }
} else {
  for (const { path, kind } of problems) {
    const file = join(TARGET, path);
    if (kind === "has no source") rmSync(file);
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, expected.get(path));
    }
  }
  if (existsSync(TARGET)) {
    for (const entry of readdirSync(TARGET, { withFileTypes: true })) {
      const path = join(TARGET, entry.name);
      if (entry.isDirectory() && listFiles(path).length === 0) rmSync(path, { recursive: true });
    }
  }
  console.log(`Wrote ${problems.length} change(s); ${skills.length} skills in .claude/skills.`);
}
