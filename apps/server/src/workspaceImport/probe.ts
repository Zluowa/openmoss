// FILE: probe.ts
// Purpose: Detect importable local data for every supported external agent.
// Layer: Server import helper

import * as fs from "node:fs/promises";

import type {
  ServerSettings,
  WorkspaceImportCategoryCounts,
  WorkspaceImportProbeResult,
  WorkspaceImportSourceKind,
  WorkspaceImportSourcePreview,
} from "@synara/contracts";
import { collectImportChats, inspectCodexChatInventory, readSourceSettings } from "./chats";
import { readWorkspaceImportHistory, readWorkspaceImportSync } from "./history";
import { canonicalWorkspaceImportSources, workspaceImportProviderForSource } from "./providers";
import { countImportProjects, discoverImportResources } from "./resources";
import { absorbHonorAbleSettings } from "./settingsAbsorb";
import { discoverImportSkills } from "./skills";
import { resourceRootsForSource } from "./paths";

export interface WorkspaceImportProbeContext {
  readonly homeDir: string;
  readonly mossCwd: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now: Date;
  readonly currentSettings: ServerSettings;
  readonly stateDir?: string | undefined;
}

async function firstExistingPath(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await fs.access(path);
      return path;
    } catch {
      // Continue through documented locations.
    }
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: values.length });
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () => worker()),
  );
  return results;
}

async function probeSource(
  source: WorkspaceImportSourceKind,
  context: WorkspaceImportProbeContext,
): Promise<WorkspaceImportSourcePreview> {
  const pathInput = {
    homeDir: context.homeDir,
    platform: context.platform,
    env: context.env,
  } as const;
  const [skills, settingsRaw, chatInventory, resources, projectCount] = await Promise.all([
    discoverImportSkills({ source, ...pathInput }),
    readSourceSettings({ source, ...pathInput }),
    source === "codex"
      ? inspectCodexChatInventory({ ...pathInput, now: context.now })
      : collectImportChats({
          source,
          ...pathInput,
          now: context.now,
          fallbackCwd: context.mossCwd,
        }),
    discoverImportResources({ source, ...pathInput }),
    countImportProjects({ source, ...pathInput, fallbackCwd: context.mossCwd }),
  ]);
  const absorbed = absorbHonorAbleSettings({
    source,
    raw: settingsRaw,
    current: context.currentSettings,
  });
  const honorAbleSettingCount = absorbed.changes.filter(
    (change) => change.action === "applied",
  ).length;
  const chatCount = "chats" in chatInventory ? chatInventory.chats.length : chatInventory.chatCount;
  const olderChatCount = chatInventory.olderChatCount;
  const chatProjectCount =
    "chats" in chatInventory
      ? new Set(chatInventory.chats.map((chat) => chat.workingDirectory)).size
      : 0;
  const categoryCounts: WorkspaceImportCategoryCounts = {
    settings: honorAbleSettingCount,
    skills: skills.length,
    agents: resources.counts.agents,
    commands: resources.counts.commands,
    hooks: resources.counts.hooks,
    mcp: resources.counts.mcp,
    plugins: resources.counts.plugins,
    memory: resources.counts.memory,
    projects: Math.max(projectCount, chatProjectCount),
    chats: chatCount,
  };
  const descriptor = workspaceImportProviderForSource(source);
  const detectedPath = await firstExistingPath([
    ...descriptor.settingsPaths(pathInput),
    ...descriptor.skillRoots(pathInput),
    ...descriptor.chatRoots(pathInput),
    ...resourceRootsForSource(source, "projects", pathInput),
  ]);
  const present =
    skills.length > 0 ||
    settingsRaw !== null ||
    chatCount > 0 ||
    resources.resources.length > 0 ||
    projectCount > 0;
  return {
    source,
    present,
    displayName: descriptor.label,
    ...(detectedPath ? { detectedPath } : {}),
    skillCount: skills.length,
    honorAbleSettingCount,
    chatCount,
    olderChatCount,
    projectCount: categoryCounts.projects,
    categoryCounts,
  };
}

export async function probeWorkspaceImport(
  context: WorkspaceImportProbeContext,
): Promise<WorkspaceImportProbeResult> {
  // Probing traverses several provider trees and transcript files. Bound the
  // source fan-out so a single RPC cannot create an unbounded I/O burst.
  const sources = await mapWithConcurrency(canonicalWorkspaceImportSources(), 2, (source) =>
    probeSource(source, context),
  );
  const stateDir = context.stateDir;
  if (!stateDir) {
    return {
      sources,
      requiresSourceChoice: sources.filter((source) => source.present).length > 1,
    };
  }
  const [sync, history] = await Promise.all([
    readWorkspaceImportSync(stateDir),
    readWorkspaceImportHistory(stateDir),
  ]);
  return {
    sources,
    requiresSourceChoice: sources.filter((source) => source.present).length > 1,
    sync,
    history,
  };
}
