/**
 * Moss unified-source bootstrap (ported from 1code `moss-source/bootstrap.ts`).
 *
 * Idempotently creates the `.moss` resource tree with starter entries. Paths
 * that already exist are reported as `skipped` and never rewritten, so user
 * content and the existing moss control-plane assets (`config.json`,
 * `mission.md`, `ledger/**`, fixtures, parity reports) are preserved
 * byte-for-byte.
 *
 * Starter contents are moss-adapted:
 * - The `config.json` starter decodes as `MossCanonicalConfig`, the schema the
 *   control plane already consumes via `mossConfigProjection`/`mossLaunchPlan`.
 * - The `providers.yaml` starter enumerates every supported Moss provider
 *   with its default model (write-only in this slice; nothing parses YAML yet).
 * - No plugin starter: imported plugin bundles are user-owned and are never
 *   invented or overwritten by bootstrap.
 */
import { access, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SUPPORTED_PROVIDER_KINDS, type MossCanonicalConfig } from "@synara/contracts";

import { getDefaultModel } from "./model";
import { MOSS_SESSION_START_EVENT } from "./mossHooks";
import { computeHookTrustHash, trustHook } from "./mossHookTrust";
import {
  MOSS_RELATIVE_PATHS,
  MOSS_SOURCE_VERSION,
  getMossBootstrapDirectories,
  getMossSourceLayout,
} from "./mossSourceLayout";

// The starter hook Moss bootstraps is a managed, side-effect-free probe. Since
// Moss ships it (rather than the user authoring an unreviewed hook), it is
// trusted by default so the SessionStart pipeline is observable out of the box.
// User-authored hooks still start untrusted and are gated until reviewed.
export const MOSS_STARTER_HOOK_NAME = "session-start";
export const MOSS_STARTER_HOOK_EVENT = MOSS_SESSION_START_EVENT;
export const MOSS_STARTER_HOOK_COMMAND = 'echo "moss:session-start $MOSS_HOOK_ENGINE"';

export const MOSS_STARTER_MEMORY_NAME = "moss-workspace";
export const MOSS_STARTER_SKILL_NAME = "moss-workspace";

export interface EnsureMossSourceOptions {
  readonly projectPath: string;
}

export interface EnsureMossSourceResult {
  projectPath: string;
  root: string;
  status: "created" | "updated" | "skipped" | "conflict";
  created: string[];
  skipped: string[];
  conflicts: Array<{ path: string; reason: string }>;
  reason?: string;
}

const DEFAULT_BOOTSTRAP_PROVIDER = "codex";

const DEFAULT_MOSS_INSTRUCTIONS = `# Moss

This workspace uses Moss Unified Source as the single source of truth for rules, memory, plugins, skills, MCP, hooks, subagents, and provider routing.

- Keep canonical configuration under .moss.
- Project provider-native files (Codex, Claude Agent, Cursor, Gemini, Antigravity, Grok, OpenCode, Pi) from .moss instead of maintaining duplicate real data.
- Sessions may remain provider-native, but shared resources and provider routing belong to Moss.
`;

const STARTER_CANONICAL_CONFIG: MossCanonicalConfig = {
  version: MOSS_SOURCE_VERSION,
  name: "Moss Workspace",
  defaultProvider: DEFAULT_BOOTSTRAP_PROVIDER,
  providers: {
    codex: { model: getDefaultModel("codex") },
    claudeAgent: { model: getDefaultModel("claudeAgent") },
  },
  mcp: [],
  skills: [],
  memory: [
    {
      name: MOSS_STARTER_MEMORY_NAME,
      source: `${MOSS_RELATIVE_PATHS.memoryRoot}/${MOSS_STARTER_MEMORY_NAME}.md`,
      enabled: true,
    },
  ],
  hooks: [
    {
      name: MOSS_STARTER_HOOK_NAME,
      source: `${MOSS_RELATIVE_PATHS.hooksRoot}/${MOSS_STARTER_HOOK_NAME}.md`,
      enabled: true,
    },
  ],
  tools: {
    allow: [],
    deny: [],
  },
};

const DEFAULT_CANONICAL_CONFIG = `${JSON.stringify(STARTER_CANONICAL_CONFIG, null, 2)}\n`;

function renderStarterProvidersYaml(): string {
  const lines: string[] = [
    `version: ${MOSS_SOURCE_VERSION}`,
    `defaultProvider: ${DEFAULT_BOOTSTRAP_PROVIDER}`,
    "providers:",
  ];
  for (const provider of SUPPORTED_PROVIDER_KINDS) {
    lines.push(`  ${provider}:`);
    lines.push(`    model: ${getDefaultModel(provider) ?? "null"}`);
  }
  return `${lines.join("\n")}\n`;
}

const DEFAULT_PROVIDER_CONFIG = renderStarterProvidersYaml();

const DEFAULT_MCP_CONFIG = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;

const DEFAULT_STARTER_MEMORY = `---
name: ${MOSS_STARTER_MEMORY_NAME}
description: Canonical Moss workspace operating memory.
---

Moss owns one shared source for this workspace. Rules, memory, plugins, skills, MCP servers, hooks, subagents, and provider routing live under .moss and are projected into each supported provider (Codex, Claude Agent, Cursor, Gemini, Antigravity, Grok, OpenCode, Pi) as needed.

Do not maintain a second real copy in provider-native folders. If a provider needs a native path, use the Moss projection or adapter output.
`;

const DEFAULT_STARTER_SKILL = `---
name: ${MOSS_STARTER_SKILL_NAME}
description: Use the Moss unified workspace source and shared resource map.
---

# Moss Workspace

Use this skill when a task depends on workspace rules, shared memory, installed tools, plugins, hooks, or provider routing.

## Protocol

1. Treat ${MOSS_RELATIVE_PATHS.sourceInstruction} as the canonical rules file.
2. Read ${MOSS_RELATIVE_PATHS.workspaceConfig} for workspace defaults.
3. Use ${MOSS_RELATIVE_PATHS.memoryRoot}, ${MOSS_RELATIVE_PATHS.skillsRoot}, ${MOSS_RELATIVE_PATHS.pluginsRoot}, ${dirname(MOSS_RELATIVE_PATHS.mcpConfig)}, ${MOSS_RELATIVE_PATHS.hooksRoot}, ${MOSS_RELATIVE_PATHS.subagentsRoot}, and ${MOSS_RELATIVE_PATHS.providersConfig} as the only real resource source.
4. If a provider needs a native path, use the Moss projection or adapter output instead of editing the native copy.
`;

const DEFAULT_STARTER_HOOK = `---
name: ${MOSS_STARTER_HOOK_NAME}
description: Starter hook bootstrapped from Moss Unified Source. Runs on every session start.
event: ${MOSS_STARTER_HOOK_EVENT}
command: ${MOSS_STARTER_HOOK_COMMAND}
enabled: true
---

This hook runs on every Moss SessionStart. The default command is a safe,
side-effect-free probe that echoes the starting provider id so you can confirm
the hook pipeline is live in the runtime log. Replace the frontmatter
\`command\` with your own SessionStart automation, or set \`enabled: false\` to
turn it off.
`;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDefaultFile(params: {
  filePath: string;
  content: string;
  created: string[];
  skipped: string[];
}): Promise<void> {
  if (await pathExists(params.filePath)) {
    params.skipped.push(params.filePath);
    return;
  }

  await mkdir(dirname(params.filePath), { recursive: true });
  await writeFile(params.filePath, params.content, "utf8");
  params.created.push(params.filePath);
}

export async function ensureMossSource(
  options: EnsureMossSourceOptions,
): Promise<EnsureMossSourceResult> {
  const projectPath = resolve(options.projectPath);
  const layout = getMossSourceLayout(projectPath);
  const result: EnsureMossSourceResult = {
    projectPath,
    root: layout.root,
    status: "skipped",
    created: [],
    skipped: [],
    conflicts: [],
  };

  try {
    const stat = await lstat(layout.root);
    if (!stat.isDirectory()) {
      result.status = "conflict";
      result.conflicts.push({
        path: layout.root,
        reason: ".moss exists and is not a directory.",
      });
      return result;
    }
  } catch {
    await mkdir(layout.root, { recursive: true });
    result.created.push(layout.root);
  }

  for (const dirPath of getMossBootstrapDirectories(layout)) {
    if (await pathExists(dirPath)) {
      result.skipped.push(dirPath);
      continue;
    }
    await mkdir(dirPath, { recursive: true });
    result.created.push(dirPath);
  }

  await ensureDefaultFile({
    filePath: layout.sourceInstruction,
    content: DEFAULT_MOSS_INSTRUCTIONS,
    created: result.created,
    skipped: result.skipped,
  });
  await ensureDefaultFile({
    filePath: layout.workspaceConfig,
    content: DEFAULT_CANONICAL_CONFIG,
    created: result.created,
    skipped: result.skipped,
  });
  await ensureDefaultFile({
    filePath: layout.providersConfig,
    content: DEFAULT_PROVIDER_CONFIG,
    created: result.created,
    skipped: result.skipped,
  });
  await ensureDefaultFile({
    filePath: layout.mcpConfig,
    content: DEFAULT_MCP_CONFIG,
    created: result.created,
    skipped: result.skipped,
  });
  await ensureDefaultFile({
    filePath: join(layout.memoryRoot, `${MOSS_STARTER_MEMORY_NAME}.md`),
    content: DEFAULT_STARTER_MEMORY,
    created: result.created,
    skipped: result.skipped,
  });
  await ensureDefaultFile({
    filePath: join(layout.skillsRoot, MOSS_STARTER_SKILL_NAME, "SKILL.md"),
    content: DEFAULT_STARTER_SKILL,
    created: result.created,
    skipped: result.skipped,
  });
  const starterHookPath = join(layout.hooksRoot, `${MOSS_STARTER_HOOK_NAME}.md`);
  const starterHookExisted = await pathExists(starterHookPath);
  await ensureDefaultFile({
    filePath: starterHookPath,
    content: DEFAULT_STARTER_HOOK,
    created: result.created,
    skipped: result.skipped,
  });
  if (!starterHookExisted) {
    // Trust the freshly bootstrapped managed starter hook at its known hash so
    // the runtime trust gate lets it run without a manual review step.
    await trustHook({
      projectPath,
      hookName: MOSS_STARTER_HOOK_NAME,
      trustedHash: computeHookTrustHash({
        command: MOSS_STARTER_HOOK_COMMAND,
        event: MOSS_STARTER_HOOK_EVENT,
      }),
    });
  }

  if (result.created.length > 0) {
    result.status = result.skipped.length > 0 ? "updated" : "created";
    return result;
  }

  result.reason = "Moss Unified Source already exists.";
  return result;
}
