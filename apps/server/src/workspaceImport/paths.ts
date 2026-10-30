// FILE: paths.ts
// Purpose: Clean-room filesystem locations for supported external-agent data.
// Layer: Server import helper

import * as nodePath from "node:path";

import type { WorkspaceImportCategoryKind, WorkspaceImportSourceKind } from "@synara/contracts";
import { workspaceImportProviderForSource } from "./providers";

export function resolveClaudeHomeDir(input: {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): string {
  const configDir = input.env?.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) {
    return configDir;
  }
  return nodePath.join(input.homeDir, ".claude");
}

export function resolveClaudeProjectsRoot(input: {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): string {
  return nodePath.join(resolveClaudeHomeDir(input), "projects");
}

export function claudeSkillRoots(input: {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): string[] {
  return [nodePath.join(resolveClaudeHomeDir(input), "skills")];
}

export function claudeSettingsPaths(input: {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): string[] {
  const claudeHome = resolveClaudeHomeDir(input);
  return [nodePath.join(claudeHome, "settings.json"), nodePath.join(input.homeDir, ".claude.json")];
}

export function cursorSkillRoots(input: { readonly homeDir: string }): string[] {
  return [
    nodePath.join(input.homeDir, ".cursor", "skills-cursor"),
    nodePath.join(input.homeDir, ".cursor", "skills"),
  ];
}

export function cursorSettingsPaths(input: {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): string[] {
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
    const appData = input.env?.APPDATA?.trim();
    if (appData) {
      paths.push(nodePath.join(appData, "Cursor", "User", "settings.json"));
    }
  } else {
    paths.push(nodePath.join(input.homeDir, ".config", "Cursor", "User", "settings.json"));
  }
  paths.push(nodePath.join(input.homeDir, ".cursor", "settings.json"));
  return paths;
}

export function cursorChatRoots(input: { readonly homeDir: string }): string[] {
  return [
    nodePath.join(input.homeDir, ".cursor", "chats"),
    nodePath.join(input.homeDir, ".cursor", "projects"),
  ];
}

export function skillRootsForSource(
  source: WorkspaceImportSourceKind,
  input: {
    readonly homeDir: string;
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv | undefined;
  },
): string[] {
  return workspaceImportProviderForSource(source)
    .skillRoots({
      ...input,
      platform: input.platform ?? process.platform,
    })
    .slice();
}

/** All documented local roots for a source/category. */
export function resourceRootsForSource(
  source: WorkspaceImportSourceKind,
  category: WorkspaceImportCategoryKind,
  input: {
    readonly homeDir: string;
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv | undefined;
  },
): string[] {
  return workspaceImportProviderForSource(source)
    .resourceRoots(category, {
      homeDir: input.homeDir,
      platform: input.platform ?? process.platform,
      env: input.env,
    })
    .slice();
}

export function chatRootsForSource(
  source: WorkspaceImportSourceKind,
  input: {
    readonly homeDir: string;
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv | undefined;
  },
): string[] {
  return workspaceImportProviderForSource(source)
    .chatRoots({
      homeDir: input.homeDir,
      platform: input.platform ?? process.platform,
      env: input.env,
    })
    .slice();
}

export function settingsPathsForSource(
  source: WorkspaceImportSourceKind,
  input: {
    readonly homeDir: string;
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv | undefined;
  },
): string[] {
  return workspaceImportProviderForSource(source)
    .settingsPaths({
      homeDir: input.homeDir,
      platform: input.platform ?? process.platform,
      env: input.env,
    })
    .slice();
}

export function decodeClaudeProjectFolderName(folderName: string): string | null {
  // Claude's legacy project directory encoding replaces several different
  // path characters with `-`. It is intentionally lossy: a dash can mean a
  // separator or a literal dash in the original path. Returning a guessed
  // path can import a completely unrelated workspace, so transcript/index
  // cwd metadata is the only authoritative source. Keep this helper for API
  // compatibility; callers receive null when no metadata is available.
  void folderName;
  return null;
}

export function isSafeSkillName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    !trimmed.includes("\0")
  );
}
