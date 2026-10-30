// FILE: skillsCatalog.test.ts
// Purpose: Verifies the unified cross-provider skills catalog discovery, dedup
//          precedence, merge with provider-native results, and toggle filtering.
// Layer: Server provider tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProviderSkillDescriptor } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRejectedFileAlias } from "../../../../scripts/fixtures/filesystem-links.ts";

import {
  clearSkillsCatalogCacheForTests,
  collectSkillMarkdownPaths,
  discoverSkillsCatalog,
  ensureMossBundledSkills,
  filterDisabledSkills,
  mergeSkillsIntoCatalog,
  parseSkillFrontmatter,
  readRegisteredSkillContent,
} from "./skillsCatalog.ts";
import { pathIsWithin } from "./claudePluginSkills.ts";
import { MOSS_PLUGIN_CREATOR_SKILL } from "../account/mossPluginCreatorSkill.ts";
import { MOSS_SKILL_CREATOR_SKILL } from "./mossSkillCreatorSkill.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

let root: string;
let homeDir: string;
let mossBaseDir: string;

async function writeSkill(skillDir: string, name: string, description: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

# ${name}
`,
  );
}

function claudePluginInstallPath(marketplace: string, plugin: string, version: string): string {
  return path.join(homeDir, ".claude", "plugins", "cache", marketplace, plugin, version);
}

async function writeClaudePluginManifest(
  plugins: Record<string, ReadonlyArray<Record<string, unknown>> | unknown>,
): Promise<void> {
  const manifestPath = path.join(homeDir, ".claude", "plugins", "installed_plugins.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ version: 2, plugins }, null, 2));
}

beforeEach(() => {
  clearSkillsCatalogCacheForTests();
  root = mkdtempSync(path.join(os.tmpdir(), "moss-skills-catalog-"));
  homeDir = path.join(root, "home");
  mossBaseDir = path.join(homeDir, ".moss");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fsPromises.realpath).mockReset();
  rmSync(root, { recursive: true, force: true });
});

describe("strict plugin skill discovery", () => {
  it("rejects a linked root and linked Markdown files while retaining regular files", async () => {
    const outside = path.join(root, "outside");
    await writeSkill(outside, "outside", "Outside plugin install");
    const linkedRoot = path.join(root, "linked-root");
    await symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    expect(await collectSkillMarkdownPaths(linkedRoot, { followSymlinks: false })).toEqual([]);

    const skillsRoot = path.join(root, "plugin-skills");
    await mkdir(skillsRoot);
    const regularMarkdown = path.join(skillsRoot, "review.md");
    await writeFile(regularMarkdown, "# Review");
    // Windows uses a no-follow rejection junction in this Markdown-file slot.
    createRejectedFileAlias(path.join(outside, "SKILL.md"), path.join(skillsRoot, "linked.md"));
    await symlink(
      outside,
      path.join(skillsRoot, "linked-directory"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      await collectSkillMarkdownPaths(skillsRoot, {
        includeMarkdownFiles: true,
        followSymlinks: false,
      }),
    ).toEqual([regularMarkdown]);
  });
});

describe("registered skill content", () => {
  it("reads a discovered skill, including an intentionally linked provider skill", async () => {
    const source = path.join(root, "source", "review");
    await writeSkill(source, "review", "Review changes");
    const providerRoot = path.join(homeDir, ".claude", "skills");
    await mkdir(providerRoot, { recursive: true });
    await symlink(
      source,
      path.join(providerRoot, "review"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const skills = await discoverSkillsCatalog({ homeDir, mossBaseDir });
    const skill = skills.find((entry) => entry.name === "review")!;
    expect(
      await readRegisteredSkillContent({ skills, name: skill.name, path: skill.path }),
    ).toContain("description: Review changes");
    const directorySkill = { ...skill, path: path.dirname(skill.path) };
    expect(
      await readRegisteredSkillContent({
        skills: [directorySkill],
        name: directorySkill.name,
        path: directorySkill.path,
      }),
    ).toContain("description: Review changes");
  });

  it("rejects undiscovered files, changed names, oversized content and invalid UTF-8", async () => {
    const skillPath = path.join(mossBaseDir, "skills", "review", "SKILL.md");
    await writeSkill(path.dirname(skillPath), "review", "Review changes");
    const skills = await discoverSkillsCatalog({ homeDir, mossBaseDir });
    await expect(
      readRegisteredSkillContent({ skills, name: "review", path: path.join(root, "secret") }),
    ).rejects.toThrow(/no longer registered/);
    await expect(
      readRegisteredSkillContent({ skills, name: "different", path: skillPath }),
    ).rejects.toThrow(/no longer registered/);

    await writeFile(skillPath, "x".repeat(1024 * 1024 + 1));
    await expect(
      readRegisteredSkillContent({ skills, name: "review", path: skillPath }),
    ).rejects.toThrow(/file limit/);
    await writeFile(skillPath, Buffer.from([0xff]));
    await expect(
      readRegisteredSkillContent({ skills, name: "review", path: skillPath }),
    ).rejects.toThrow();
  });
});

describe("parseSkillFrontmatter", () => {
  it("parses scalar Agent Skill metadata", () => {
    expect(
      parseSkillFrontmatter(`---
name: check-code
description: "Review recent code changes"
disable-model-invocation: true
---

# Check Code
`),
    ).toEqual({
      name: "check-code",
      description: "Review recent code changes",
      "disable-model-invocation": true,
    });
  });

  it("reads block scalars and keeps nested keys from overriding top-level ones", () => {
    expect(
      parseSkillFrontmatter(`---
name: check-code
description: >-
  Review recent code changes
  before they are merged.

  Use it after every edit.
summary: |
  First line
    indented line
metadata:
  env:
    - name: API_KEY
      description: Service key
license: MIT
---
`),
    ).toEqual({
      name: "check-code",
      description: "Review recent code changes before they are merged.\nUse it after every edit.",
      summary: "First line\n  indented line",
      license: "MIT",
    });
  });

  it("does not let nested metadata fields override top-level ones", () => {
    expect(
      parseSkillFrontmatter(`---
name: check-code
description: Top-level description
metadata:
  name: nested-name
  description: nested description
tags:
  - review
allowed-tools: [Read, Grep]
---
`),
    ).toEqual({
      name: "check-code",
      description: "Top-level description",
    });
  });

  it("reads a short description kept under metadata", () => {
    expect(
      parseSkillFrontmatter(`---
name: codex-style
description: Long description
metadata:
  short-description: Short text
---
`),
    ).toEqual({
      name: "codex-style",
      description: "Long description",
      "short-description": "Short text",
    });
  });

  it("parses frontmatter with many keys without a quadratic slowdown", () => {
    const keys = Array.from({ length: 40_000 }, (_, index) => `key${index}: value`).join("\n");
    const startedAt = performance.now();
    expect(parseSkillFrontmatter(`---\nname: wide\n${keys}\n---\n`).name).toBe("wide");
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  it("falls back to the line reader for frontmatter that is not valid YAML", () => {
    expect(
      parseSkillFrontmatter(`---
name: loose
description: Use when: the user asks for it
---
`),
    ).toEqual({ name: "loose", description: "Use when: the user asks for it" });
  });
});

describe("ensureMossBundledSkills", () => {
  it("ships Plugin Creator into the portable root and keeps it current", async () => {
    const file = path.join(mossBaseDir, "skills", "plugin-creator", "SKILL.md");
    await ensureMossBundledSkills(mossBaseDir);
    expect(await fsPromises.readFile(file, "utf8")).toBe(MOSS_PLUGIN_CREATOR_SKILL);
    // Skill Creator ships beside it, so Create skill works for every CLI.
    expect(
      await fsPromises.readFile(
        path.join(mossBaseDir, "skills", "skill-creator", "SKILL.md"),
        "utf8",
      ),
    ).toBe(MOSS_SKILL_CREATOR_SKILL);

    // An older Moss-written copy is refreshed in place.
    await writeFile(file, "---\nname: plugin-creator\n---\n\n# Moss Plugin Creator\nold", "utf8");
    await ensureMossBundledSkills(mossBaseDir);
    expect(await fsPromises.readFile(file, "utf8")).toBe(MOSS_PLUGIN_CREATOR_SKILL);
  });

  it("leaves a user's own skill of the same name alone", async () => {
    const file = path.join(mossBaseDir, "skills", "plugin-creator", "SKILL.md");
    await mkdir(path.dirname(file), { recursive: true });
    const own = "---\nname: plugin-creator\ndescription: mine\n---\n\nMy own creator.";
    await writeFile(file, own, "utf8");
    await ensureMossBundledSkills(mossBaseDir);
    expect(await fsPromises.readFile(file, "utf8")).toBe(own);
  });
});

describe("pathIsWithin", () => {
  it("rejects Windows paths on another drive while preserving same-drive containment", () => {
    expect(pathIsWithin("C:\\plugins", "C:\\plugins", path.win32)).toBe(true);
    expect(pathIsWithin("C:\\plugins", "C:\\plugins\\workflow-kit", path.win32)).toBe(true);
    expect(pathIsWithin("C:\\plugins", "C:\\other", path.win32)).toBe(false);
    expect(pathIsWithin("C:\\plugins", "D:\\plugins\\workflow-kit", path.win32)).toBe(false);
  });
});

describe("discoverSkillsCatalog", () => {
  it("creates the Moss skills folder on first discovery", async () => {
    await discoverSkillsCatalog({ homeDir, mossBaseDir });
    // A plain await is enough here: access rejects when the directory is missing.
    // (node resolves undefined while bun resolves null, so don't assert the value.)
    await access(path.join(mossBaseDir, "skills"));
  });

  it("aggregates skills from moss and provider home folders with origin scopes", async () => {
    await writeSkill(path.join(mossBaseDir, "skills", "portable"), "portable", "Moss skill");
    await writeSkill(path.join(homeDir, ".codex", "skills", "codex-only"), "codex-only", "Codex");
    await writeSkill(
      path.join(homeDir, ".claude", "skills", "claude-only"),
      "claude-only",
      "Claude",
    );
    await writeSkill(
      path.join(homeDir, ".cursor", "skills", "cursor-only"),
      "cursor-only",
      "Cursor",
    );
    await writeSkill(path.join(homeDir, ".grok", "skills", "grok-only"), "grok-only", "Grok");
    await writeSkill(
      path.join(homeDir, ".config", "devin", "skills", "devin-only"),
      "devin-only",
      "Devin",
    );
    await writeSkill(
      path.join(homeDir, ".config", "cognition", "skills", "cognition-only"),
      "cognition-only",
      "Cognition",
    );
    await writeSkill(
      path.join(homeDir, ".codeium", "windsurf", "skills", "windsurf-only"),
      "windsurf-only",
      "Windsurf",
    );
    await writeSkill(
      path.join(homeDir, ".config", "opencode", "skills", "opencode-only"),
      "opencode-only",
      "OpenCode",
    );
    await writeSkill(path.join(homeDir, ".pi", "agent", "skills", "pi-only"), "pi-only", "Pi");

    const skills = await discoverSkillsCatalog({ homeDir, mossBaseDir });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    expect(byName.get("portable")?.scope).toBe("moss");
    expect(byName.get("codex-only")?.scope).toBe("codex");
    expect(byName.get("claude-only")?.scope).toBe("claude");
    expect(byName.get("cursor-only")?.scope).toBe("cursor");
    expect(byName.get("grok-only")?.scope).toBe("grok");
    expect(byName.get("devin-only")?.scope).toBe("devin");
    expect(byName.get("cognition-only")?.scope).toBe("devin");
    expect(byName.get("windsurf-only")?.scope).toBe("devin");
    expect(byName.get("opencode-only")?.scope).toBe("opencode");
    expect(byName.get("pi-only")?.scope).toBe("pi");
  });

  it("honors a custom agentDir for omp and pi skill roots", async () => {
    const ompAgentDir = path.join(root, "custom-omp-agent");
    const piAgentDir = path.join(root, "custom-pi-agent");
    await writeSkill(
      path.join(ompAgentDir, "skills", "omp-custom"),
      "omp-custom",
      "OMP profile skill",
    );
    await writeSkill(path.join(piAgentDir, "skills", "pi-custom"), "pi-custom", "Pi profile skill");
    await writeSkill(
      path.join(homeDir, ".omp", "agent", "skills", "omp-default"),
      "omp-default",
      "Default root skill",
    );

    const ompSkills = await discoverSkillsCatalog({
      homeDir,
      mossBaseDir,
      provider: "omp",
      agentDir: ompAgentDir,
    });
    expect(ompSkills.find((s) => s.name === "omp-custom")?.scope).toBe("omp");
    expect(ompSkills.find((s) => s.name === "omp-default")).toBeUndefined();

    const piSkills = await discoverSkillsCatalog({
      homeDir,
      mossBaseDir,
      provider: "pi",
      agentDir: piAgentDir,
    });
    expect(piSkills.find((s) => s.name === "pi-custom")?.scope).toBe("pi");
  });

  it("discovers Devin's project-local native skill roots", async () => {
    const cwd = path.join(root, "repo", "packages", "web");
    await mkdir(cwd, { recursive: true });
    await writeSkill(
      path.join(root, "repo", ".devin", "skills", "devin-project"),
      "devin-project",
      "Project Devin skill",
    );
    await writeSkill(
      path.join(root, "repo", ".cognition", "skills", "cognition-project"),
      "cognition-project",
      "Project Cognition skill",
    );
    await writeSkill(
      path.join(root, "repo", ".windsurf", "skills", "windsurf-project"),
      "windsurf-project",
      "Project Windsurf skill",
    );

    const skills = await discoverSkillsCatalog({
      cwd,
      homeDir,
      mossBaseDir,
      provider: "devin",
    });

    for (const name of ["devin-project", "cognition-project", "windsurf-project"]) {
      expect(skills.find((skill) => skill.name === name)).toMatchObject({ scope: "project" });
    }
  });

  it("discovers only the registered Claude plugin version for Grok with its native namespace", async () => {
    const currentInstallPath = claudePluginInstallPath("skill-forge", "workflow-kit", "1.21.0");
    const staleInstallPath = claudePluginInstallPath("skill-forge", "workflow-kit", "1.20.0");
    await writeSkill(
      path.join(currentInstallPath, "skills", "feature-delivery"),
      "feature-delivery",
      "Deliver a feature",
    );
    await writeSkill(
      path.join(staleInstallPath, "skills", "stale-only"),
      "stale-only",
      "Old cache entry",
    );
    await writeClaudePluginManifest({
      "workflow-kit@skill-forge": [
        {
          scope: "user",
          installPath: currentInstallPath,
          version: "1.21.0",
        },
      ],
    });

    const skills = await discoverSkillsCatalog({
      homeDir,
      mossBaseDir,
      provider: "grok",
    });

    expect(skills.find((skill) => skill.name === "workflow-kit:feature-delivery")).toMatchObject({
      scope: "claude",
      path: await realpath(path.join(currentInstallPath, "skills", "feature-delivery", "SKILL.md")),
    });
    expect(skills.some((skill) => skill.name.includes("stale-only"))).toBe(false);
  });

  it("dedupes duplicate Claude plugin registrations deterministically", async () => {
    const installPath = claudePluginInstallPath("skill-forge", "workflow-kit", "1.21.0");
    await writeSkill(
      path.join(installPath, "skills", "feature-delivery"),
      "feature-delivery",
      "Deliver a feature",
    );
    const install = { scope: "user", installPath, version: "1.21.0" };
    await writeClaudePluginManifest({
      "workflow-kit@skill-forge": [install, install],
    });

    const skills = await discoverSkillsCatalog({
      homeDir,
      mossBaseDir,
      includeDuplicateOrigins: true,
    });

    expect(skills.filter((skill) => skill.name === "workflow-kit:feature-delivery")).toHaveLength(
      1,
    );
  });

  it("uses deterministic plugin-id precedence when namespaces and skill names collide", async () => {
    const alphaInstallPath = claudePluginInstallPath("alpha", "workflow-kit", "1.0.0");
    const zetaInstallPath = claudePluginInstallPath("zeta", "workflow-kit", "1.0.0");
    await Promise.all([
      writeSkill(
        path.join(alphaInstallPath, "skills", "feature-delivery"),
        "feature-delivery",
        "Alpha copy",
      ),
      writeSkill(
        path.join(zetaInstallPath, "skills", "feature-delivery"),
        "feature-delivery",
        "Zeta copy",
      ),
    ]);
    await writeClaudePluginManifest({
      "workflow-kit@zeta": [{ scope: "user", installPath: zetaInstallPath }],
      "workflow-kit@alpha": [{ scope: "user", installPath: alphaInstallPath }],
    });

    const skills = await discoverSkillsCatalog({ homeDir, mossBaseDir });
    const featureDelivery = skills.find((skill) => skill.name === "workflow-kit:feature-delivery");

    expect(featureDelivery?.description).toBe("Alpha copy");
    expect(featureDelivery?.path).toContain(path.join("cache", "alpha", "workflow-kit"));
  });

  it("includes user and matching project Claude plugins but excludes other projects", async () => {
    const cwd = path.join(root, "repo", "packages", "web");
    const otherProject = path.join(root, "other-repo");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(otherProject, { recursive: true })]);
    const userInstallPath = claudePluginInstallPath("plugins", "user-tools", "1.0.0");
    const projectInstallPath = claudePluginInstallPath("plugins", "project-tools", "1.0.0");
    const otherInstallPath = claudePluginInstallPath("plugins", "other-tools", "1.0.0");
    await Promise.all([
      writeSkill(path.join(userInstallPath, "skills", "user-skill"), "user-skill", "User"),
      writeSkill(
        path.join(projectInstallPath, "skills", "project-skill"),
        "project-skill",
        "Project",
      ),
      writeSkill(path.join(otherInstallPath, "skills", "other-skill"), "other-skill", "Other"),
    ]);
    await writeClaudePluginManifest({
      "user-tools@plugins": [{ scope: "user", installPath: userInstallPath }],
      "project-tools@plugins": [
        { scope: "project", projectPath: path.join(root, "repo"), installPath: projectInstallPath },
      ],
      "other-tools@plugins": [
        { scope: "project", projectPath: otherProject, installPath: otherInstallPath },
      ],
    });

    const skills = await discoverSkillsCatalog({ cwd, homeDir, mossBaseDir });
    expect(skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["user-tools:user-skill", "project-tools:project-skill"]),
    );
    expect(skills.some((skill) => skill.name === "other-tools:other-skill")).toBe(false);
  });

  it("uses one highest-precedence applicable install per Claude plugin ID", async () => {
    const cwd = path.join(root, "repo", "packages", "web");
    await mkdir(cwd, { recursive: true });
    const userInstallPath = claudePluginInstallPath("plugins", "workflow-kit", "1.0.0");
    const projectInstallPath = claudePluginInstallPath("plugins", "workflow-kit", "2.0.0");
    await Promise.all([
      writeSkill(path.join(userInstallPath, "skills", "user-only"), "user-only", "User copy only"),
      writeSkill(
        path.join(projectInstallPath, "skills", "project-only"),
        "project-only",
        "Project copy only",
      ),
    ]);
    await writeClaudePluginManifest({
      "workflow-kit@plugins": [
        { scope: "user", installPath: userInstallPath },
        {
          scope: "project",
          projectPath: path.join(root, "repo"),
          installPath: projectInstallPath,
        },
      ],
    });

    const skills = await discoverSkillsCatalog({ cwd, homeDir, mossBaseDir });
    expect(skills.map((skill) => skill.name)).toContain("workflow-kit:project-only");
    expect(skills.map((skill) => skill.name)).not.toContain("workflow-kit:user-only");
  });

  it("ignores malformed registrations and install paths outside Claude's plugin cache", async () => {
    const validInstallPath = claudePluginInstallPath("plugins", "valid", "1.0.0");
    const outsideInstallPath = path.join(root, "outside-plugin");
    await writeSkill(path.join(validInstallPath, "skills", "valid-skill"), "valid-skill", "Valid");
    await writeSkill(
      path.join(outsideInstallPath, "skills", "outside-skill"),
      "outside-skill",
      "Outside",
    );
    await symlink(
      path.join(outsideInstallPath, "skills", "outside-skill"),
      path.join(validInstallPath, "skills", "linked-outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeClaudePluginManifest({
      "valid@plugins": [{ scope: "user", installPath: validInstallPath }],
      "outside@plugins": [{ scope: "user", installPath: outsideInstallPath }],
      "relative@plugins": [{ scope: "user", installPath: "relative/plugin" }],
      "missing@plugins": [{ scope: "user", installPath: path.join(validInstallPath, "missing") }],
      malformed: [{ scope: "user", installPath: validInstallPath }],
      "wrong-shape@plugins": { scope: "user", installPath: validInstallPath },
    });

    const skills = await discoverSkillsCatalog({ homeDir, mossBaseDir });
    expect(skills.map((skill) => skill.name)).toContain("valid:valid-skill");
    expect(skills.some((skill) => skill.name.includes("outside-skill"))).toBe(false);
    expect(skills.filter((skill) => skill.name === "valid:valid-skill")).toHaveLength(1);
  });

  it("follows symlinked skill directories from provider homes", async () => {
    const realSkillDir = path.join(root, "linked-skills", "check-code");
    await writeSkill(realSkillDir, "check-code", "Linked Claude skill");
    await mkdir(path.join(homeDir, ".claude", "skills"), { recursive: true });
    await symlink(
      realSkillDir,
      path.join(homeDir, ".claude", "skills", "check-code"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const skills = await discoverSkillsCatalog({
      homeDir,
      mossBaseDir,
      includeDuplicateOrigins: true,
    });

    const linkedSkill = skills.find((skill) => skill.name === "check-code");
    expect(linkedSkill?.scope).toBe("claude");
    expect(linkedSkill?.path).toContain(path.join(".claude", "skills", "check-code", "SKILL.md"));
  });

  it("can include duplicate skill names from different origins for settings", async () => {
    await writeSkill(path.join(homeDir, ".codex", "skills", "reviewer"), "reviewer", "Codex");
    await writeSkill(path.join(homeDir, ".claude", "skills", "reviewer"), "reviewer", "Claude");

    const defaultCatalog = await discoverSkillsCatalog({ homeDir, mossBaseDir });
    expect(defaultCatalog.filter((skill) => skill.name === "reviewer")).toHaveLength(1);
    expect(defaultCatalog.find((skill) => skill.name === "reviewer")?.scope).toBe("codex");

    const settingsCatalog = await discoverSkillsCatalog({
      homeDir,
      mossBaseDir,
      includeDuplicateOrigins: true,
    });
    expect(settingsCatalog.filter((skill) => skill.name === "reviewer")).toHaveLength(2);
    expect(settingsCatalog.map((skill) => skill.scope).sort()).toEqual(["claude", "codex"]);
  });

  it("prefers the provider-native copy and falls back to Moss for that provider", async () => {
    await writeSkill(path.join(mossBaseDir, "skills", "shared"), "shared", "Moss copy");
    await writeSkill(path.join(homeDir, ".codex", "skills", "shared"), "shared", "Codex copy");
    await writeSkill(path.join(mossBaseDir, "skills", "only-moss"), "only-moss", "Fallback");

    const codexView = await discoverSkillsCatalog({ homeDir, mossBaseDir, provider: "codex" });
    const codexShared = codexView.find((skill) => skill.name === "shared");
    expect(codexShared?.scope).toBe("codex");
    expect(codexShared?.path).toContain(path.join(".codex", "skills"));
    expect(codexView.some((skill) => skill.name === "only-moss")).toBe(true);

    // A provider without its own copy resolves the Moss fallback.
    const claudeView = await discoverSkillsCatalog({
      homeDir,
      mossBaseDir,
      provider: "claudeAgent",
    });
    const claudeShared = claudeView.find((skill) => skill.name === "shared");
    expect(claudeShared?.scope).toBe("moss");
  });

  it("uses documented provider alias roots before Moss fallbacks", async () => {
    await writeSkill(path.join(mossBaseDir, "skills", "shared"), "shared", "Moss copy");
    await writeSkill(path.join(homeDir, ".agents", "skills", "shared"), "shared", "Agents alias");
    const antigravityView = await discoverSkillsCatalog({
      homeDir,
      mossBaseDir,
      provider: "antigravity",
    });

    expect(antigravityView.find((skill) => skill.name === "shared")?.scope).toBe("agents");
  });

  it("uses provider-native roots before shared aliases for Grok and Pi", async () => {
    await writeSkill(path.join(mossBaseDir, "skills", "shared"), "shared", "Moss copy");
    await writeSkill(path.join(homeDir, ".agents", "skills", "shared"), "shared", "Agents alias");
    await writeSkill(path.join(homeDir, ".grok", "skills", "shared"), "shared", "Grok copy");
    await writeSkill(path.join(homeDir, ".pi", "agent", "skills", "shared"), "shared", "Pi copy");

    const grokView = await discoverSkillsCatalog({
      homeDir,
      mossBaseDir,
      provider: "grok",
    });
    const piView = await discoverSkillsCatalog({
      homeDir,
      mossBaseDir,
      provider: "pi",
    });

    expect(grokView.find((skill) => skill.name === "shared")?.scope).toBe("grok");
    expect(piView.find((skill) => skill.name === "shared")?.scope).toBe("pi");
  });

  it("discovers Pi direct markdown skills from Pi roots", async () => {
    const piRoot = path.join(homeDir, ".pi", "agent", "skills");
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      path.join(piRoot, "direct-review.md"),
      `---
name: direct-review
description: Direct Pi markdown skill
---

# Direct Review
`,
    );

    const skills = await discoverSkillsCatalog({ homeDir, mossBaseDir });

    const directSkill = skills.find((skill) => skill.name === "direct-review");
    expect(directSkill?.scope).toBe("pi");
    expect(directSkill?.path).toContain(path.join(".pi", "agent", "skills", "direct-review.md"));
  });

  it("serves cached results within the TTL and rescans on forceReload", async () => {
    await writeSkill(path.join(mossBaseDir, "skills", "first"), "first", "First skill");

    const initial = await discoverSkillsCatalog({ homeDir, mossBaseDir });
    expect(initial.map((skill) => skill.name)).toEqual(["first"]);

    // A skill added after the first scan is invisible to the cached entry...
    await writeSkill(path.join(mossBaseDir, "skills", "second"), "second", "Second skill");
    const cached = await discoverSkillsCatalog({ homeDir, mossBaseDir });
    expect(cached.map((skill) => skill.name)).toEqual(["first"]);

    // ...but forceReload bypasses the cache and refreshes it.
    const reloaded = await discoverSkillsCatalog({ homeDir, mossBaseDir, forceReload: true });
    expect(reloaded.map((skill) => skill.name).sort()).toEqual(["first", "second"]);
  });

  it("refreshes an in-flight discovery after installation instead of returning its old snapshot", async () => {
    const firstPath = path.join(mossBaseDir, "skills", "first", "SKILL.md");
    await writeSkill(path.dirname(firstPath), "first", "First skill");
    let releaseRead!: () => void;
    let markRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markRead = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const { realpath: resolvePath } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let held = false;
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (...args) => {
      const result = await resolvePath(...args);
      if (!held && args[0] === firstPath) {
        held = true;
        markRead();
        await readReleased;
      }
      return result;
    });

    const initial = discoverSkillsCatalog({ homeDir, mossBaseDir });
    await readStarted;
    await writeSkill(path.join(mossBaseDir, "skills", "second"), "second", "New installation");
    const refresh = discoverSkillsCatalog({ homeDir, mossBaseDir, forceReload: true });
    releaseRead();

    expect((await initial).map((skill) => skill.name)).toEqual(["first"]);
    expect((await refresh).map((skill) => skill.name).sort()).toEqual(["first", "second"]);
    expect(
      (await discoverSkillsCatalog({ homeDir, mossBaseDir })).map((skill) => skill.name).sort(),
    ).toEqual(["first", "second"]);
  });

  it("includes project-level .moss skills when a cwd is provided", async () => {
    const cwd = path.join(root, "repo", "packages", "web");
    await mkdir(cwd, { recursive: true });
    await writeSkill(
      path.join(root, "repo", ".moss", "skills", "repo-skill"),
      "repo-skill",
      "Project skill",
    );

    const skills = await discoverSkillsCatalog({ cwd, homeDir, mossBaseDir });
    expect(skills.find((skill) => skill.name === "repo-skill")?.scope).toBe("project");
  });

  it("keeps home origins when the cwd lives under the home dir", async () => {
    // The home dir is an ancestor of the cwd here, so home skill folders are
    // reachable as "project" roots too; they must keep their true origin.
    const cwd = path.join(homeDir, "projects", "app");
    await mkdir(cwd, { recursive: true });
    await writeSkill(path.join(homeDir, ".codex", "skills", "from-codex"), "from-codex", "Codex");
    await writeSkill(path.join(mossBaseDir, "skills", "portable"), "portable", "Moss");

    const skills = await discoverSkillsCatalog({ cwd, homeDir, mossBaseDir });

    const names = skills.map((skill) => skill.name);
    expect(names.filter((name) => name === "from-codex")).toHaveLength(1);
    expect(skills.find((skill) => skill.name === "from-codex")?.scope).toBe("codex");
    expect(skills.find((skill) => skill.name === "portable")?.scope).toBe("moss");
  });

  it("dedupes same-named skills within a root deterministically", async () => {
    await writeSkill(path.join(mossBaseDir, "skills", "zeta"), "twin", "Copy in zeta");
    await writeSkill(path.join(mossBaseDir, "skills", "alpha"), "twin", "Copy in alpha");

    const skills = await discoverSkillsCatalog({ homeDir, mossBaseDir });
    const twins = skills.filter((skill) => skill.name === "twin");
    expect(twins).toHaveLength(1);
    expect(twins[0]?.path).toContain(path.join("skills", "alpha"));
  });
});

describe("mergeSkillsIntoCatalog", () => {
  const descriptor = (name: string, scope: string): ProviderSkillDescriptor => ({
    name,
    path: `/tmp/${scope}/${name}/SKILL.md`,
    enabled: true,
    scope,
  });

  it("keeps provider-native entries and appends catalog-only entries", () => {
    const merged = mergeSkillsIntoCatalog({
      native: [descriptor("shared", "codex-native")],
      catalog: [descriptor("Shared", "moss"), descriptor("extra", "moss")],
    });
    expect(merged).toHaveLength(2);
    expect(merged.find((skill) => skill.name.toLowerCase() === "shared")?.scope).toBe(
      "codex-native",
    );
    expect(merged.some((skill) => skill.name === "extra")).toBe(true);
  });
});

describe("filterDisabledSkills", () => {
  it("filters disabled skills case-insensitively", () => {
    const skills: ProviderSkillDescriptor[] = [
      { name: "Reviewer", path: "/tmp/a/SKILL.md", enabled: true },
      { name: "writer", path: "/tmp/b/SKILL.md", enabled: true },
    ];
    expect(filterDisabledSkills(skills, ["reviewer"]).map((skill) => skill.name)).toEqual([
      "writer",
    ]);
    expect(filterDisabledSkills(skills, [])).toHaveLength(2);
  });
});
