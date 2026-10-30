// FILE: providers.ts
// Purpose: One explicit, extensible registry for external-agent import sources.
// Layer: Server import helper
//
// The registry is deliberately data-only.  It describes documented local
// locations and Moss's destination provider; it never starts an agent or
// executes imported hooks/plugins.  Adding a provider therefore consists of
// adding paths and a parser choice, instead of scattering provider checks
// through probe/apply/chat code.

import * as nodePath from "node:path";

import type {
  SupportedProviderKind,
  WorkspaceImportCanonicalSourceKind,
  WorkspaceImportCategoryKind,
  WorkspaceImportSourceKind,
} from "@synara/contracts";
import { normalizeWorkspaceImportSource } from "@synara/contracts";

export interface WorkspaceImportPathInput {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface WorkspaceImportProviderDescriptor {
  readonly source: WorkspaceImportCanonicalSourceKind;
  readonly label: string;
  readonly mossProvider: SupportedProviderKind;
  readonly settingsPaths: (input: WorkspaceImportPathInput) => readonly string[];
  readonly skillRoots: (input: WorkspaceImportPathInput) => readonly string[];
  readonly resourceRoots: (
    category: WorkspaceImportCategoryKind,
    input: WorkspaceImportPathInput,
  ) => readonly string[];
  readonly chatRoots: (input: WorkspaceImportPathInput) => readonly string[];
}

function envPath(env: NodeJS.ProcessEnv | undefined, key: string): string | null {
  const value = env?.[key]?.trim();
  if (!value || value.includes("\0")) return null;
  // Provider overrides are filesystem roots. Relative values would resolve
  // against Moss's process cwd and could redirect an import unexpectedly.
  return nodePath.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) ? value : null;
}

function appSupportPath(input: WorkspaceImportPathInput, appName: string): string {
  if (input.platform === "darwin") {
    return nodePath.join(input.homeDir, "Library", "Application Support", appName);
  }
  if (input.platform === "win32") {
    return nodePath.join(
      envPath(input.env, "APPDATA") ?? nodePath.join(input.homeDir, "AppData", "Roaming"),
      appName,
    );
  }
  return nodePath.join(
    envPath(input.env, "XDG_CONFIG_HOME") ?? nodePath.join(input.homeDir, ".config"),
    appName.toLowerCase(),
  );
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim().length > 0))];
}

function homeRoot(input: WorkspaceImportPathInput, envKey: string, fallback: string): string {
  return envPath(input.env, envKey) ?? nodePath.join(input.homeDir, fallback);
}

function categoryRoots(base: string, category: WorkspaceImportCategoryKind): string[] {
  const names: Record<WorkspaceImportCategoryKind, readonly string[]> = {
    settings: [],
    skills: ["skills", "skill"],
    agents: ["agents", "subagents"],
    commands: ["commands", "prompts"],
    hooks: ["hooks"],
    mcp: ["mcp", "mcp-servers", "mcp_servers"],
    plugins: ["plugins"],
    memory: ["memory", "memories"],
    projects: ["projects", "workspaces"],
    chats: ["chats", "sessions", "conversations", "history"],
  };
  return names[category].map((name) => nodePath.join(base, name));
}

function claudeHome(input: WorkspaceImportPathInput): string {
  return envPath(input.env, "CLAUDE_CONFIG_DIR") ?? nodePath.join(input.homeDir, ".claude");
}

function cursorSettings(input: WorkspaceImportPathInput): string[] {
  const paths: string[] = [];
  if (input.platform === "darwin") {
    paths.push(
      nodePath.join(
        input.homeDir,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "settings.json",
      ),
    );
  } else if (input.platform === "win32") {
    const appData = envPath(input.env, "APPDATA");
    if (appData) paths.push(nodePath.join(appData, "Cursor", "User", "settings.json"));
  } else {
    paths.push(nodePath.join(input.homeDir, ".config", "Cursor", "User", "settings.json"));
  }
  paths.push(nodePath.join(input.homeDir, ".cursor", "settings.json"));
  return uniquePaths(paths);
}

function codexHome(input: WorkspaceImportPathInput): string {
  return homeRoot(input, "CODEX_HOME", ".codex");
}

function grokHomes(input: WorkspaceImportPathInput): string[] {
  return uniquePaths([
    envPath(input.env, "GROK_HOME") ?? "",
    nodePath.join(input.homeDir, ".grok"),
    nodePath.join(input.homeDir, ".config", "grok"),
    appSupportPath(input, "Grok"),
  ]);
}

function openCodeHomes(input: WorkspaceImportPathInput): string[] {
  const xdg = envPath(input.env, "XDG_CONFIG_HOME");
  return uniquePaths([
    envPath(input.env, "OPENCODE_CONFIG_DIR") ?? "",
    nodePath.join(input.homeDir, ".config", "opencode"),
    nodePath.join(input.homeDir, ".opencode"),
    nodePath.join(xdg ?? nodePath.join(input.homeDir, ".config"), "opencode"),
    appSupportPath(input, "OpenCode"),
  ]);
}

function openCodeDataHomes(input: WorkspaceImportPathInput): string[] {
  const xdg = envPath(input.env, "XDG_DATA_HOME");
  return uniquePaths([
    envPath(input.env, "OPENCODE_DATA_DIR") ?? "",
    nodePath.join(xdg ?? nodePath.join(input.homeDir, ".local", "share"), "opencode"),
    nodePath.join(input.homeDir, ".local", "share", "opencode"),
    appSupportPath(input, "OpenCode"),
  ]);
}

const claudeDescriptor: WorkspaceImportProviderDescriptor = {
  source: "claude",
  label: "Claude Code",
  mossProvider: "claudeAgent",
  settingsPaths: (input) => [
    nodePath.join(claudeHome(input), "settings.json"),
    nodePath.join(input.homeDir, ".claude.json"),
  ],
  skillRoots: (input) => [nodePath.join(claudeHome(input), "skills")],
  resourceRoots: (category, input) => categoryRoots(claudeHome(input), category),
  chatRoots: (input) => [nodePath.join(claudeHome(input), "projects")],
};

const cursorDescriptor: WorkspaceImportProviderDescriptor = {
  source: "cursor",
  label: "Cursor",
  mossProvider: "cursor",
  settingsPaths: cursorSettings,
  skillRoots: (input) => [
    nodePath.join(input.homeDir, ".cursor", "skills-cursor"),
    nodePath.join(input.homeDir, ".cursor", "skills"),
  ],
  resourceRoots: (category, input) =>
    uniquePaths([
      ...categoryRoots(nodePath.join(input.homeDir, ".cursor"), category),
      ...categoryRoots(appSupportPath(input, "Cursor"), category),
    ]),
  chatRoots: (input) => [
    nodePath.join(input.homeDir, ".cursor", "chats"),
    nodePath.join(input.homeDir, ".cursor", "projects"),
    nodePath.join(input.homeDir, ".cursor", "acp-sessions"),
    nodePath.join(appSupportPath(input, "Cursor"), "chats"),
    nodePath.join(appSupportPath(input, "Cursor"), "projects"),
  ],
};

const codexDescriptor: WorkspaceImportProviderDescriptor = {
  source: "codex",
  label: "Codex",
  mossProvider: "codex",
  settingsPaths: (input) => [
    nodePath.join(codexHome(input), "config.toml"),
    nodePath.join(codexHome(input), "config.json"),
  ],
  skillRoots: (input) => [
    nodePath.join(codexHome(input), "skills"),
    nodePath.join(input.homeDir, ".agents", "skills"),
  ],
  resourceRoots: (category, input) =>
    uniquePaths([
      ...categoryRoots(codexHome(input), category),
      ...categoryRoots(nodePath.join(input.homeDir, ".agents"), category),
    ]),
  chatRoots: (input) =>
    uniquePaths([
      ...categoryRoots(codexHome(input), "chats"),
      nodePath.join(codexHome(input), "sessions"),
      nodePath.join(codexHome(input), "conversations"),
      nodePath.join(codexHome(input), "archived_sessions"),
    ]),
};

const grokDescriptor: WorkspaceImportProviderDescriptor = {
  source: "grok",
  label: "Grok",
  mossProvider: "grok",
  settingsPaths: (input) =>
    grokHomes(input).flatMap((home) => [
      nodePath.join(home, "settings.json"),
      nodePath.join(home, "config.json"),
      nodePath.join(home, "config.toml"),
    ]),
  skillRoots: (input) => grokHomes(input).flatMap((home) => categoryRoots(home, "skills")),
  resourceRoots: (category, input) =>
    grokHomes(input).flatMap((home) => categoryRoots(home, category)),
  chatRoots: (input) => grokHomes(input).flatMap((home) => categoryRoots(home, "chats")),
};

const openCodeDescriptor: WorkspaceImportProviderDescriptor = {
  source: "opencode",
  label: "OpenCode",
  mossProvider: "opencode",
  settingsPaths: (input) =>
    openCodeHomes(input).flatMap((home) => [
      nodePath.join(home, "opencode.json"),
      nodePath.join(home, "config.json"),
      nodePath.join(home, "config.toml"),
    ]),
  skillRoots: (input) => openCodeHomes(input).flatMap((home) => categoryRoots(home, "skills")),
  resourceRoots: (category, input) =>
    openCodeHomes(input).flatMap((home) => categoryRoots(home, category)),
  chatRoots: (input) => [
    ...openCodeHomes(input).flatMap((home) => categoryRoots(home, "chats")),
    ...openCodeDataHomes(input).flatMap((home) => [
      nodePath.join(home, "storage", "session"),
      nodePath.join(home, "storage", "message"),
      nodePath.join(home, "sessions"),
    ]),
  ],
};

export const WORKSPACE_IMPORT_PROVIDERS: readonly WorkspaceImportProviderDescriptor[] = [
  claudeDescriptor,
  cursorDescriptor,
  codexDescriptor,
  grokDescriptor,
  openCodeDescriptor,
];

const providerBySource = new Map(
  WORKSPACE_IMPORT_PROVIDERS.map((descriptor) => [descriptor.source, descriptor] as const),
);

export function workspaceImportProviderForSource(
  source: WorkspaceImportSourceKind,
): WorkspaceImportProviderDescriptor {
  return providerBySource.get(normalizeWorkspaceImportSource(source)) ?? claudeDescriptor;
}

export function canonicalWorkspaceImportSources(): readonly WorkspaceImportCanonicalSourceKind[] {
  return WORKSPACE_IMPORT_PROVIDERS.map((descriptor) => descriptor.source);
}

export { claudeHome, codexHome, grokHomes, openCodeHomes, openCodeDataHomes };
