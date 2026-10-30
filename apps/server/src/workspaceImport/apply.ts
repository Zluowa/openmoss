// FILE: apply.ts
// Purpose: Apply selected external-agent resources, safe settings and recent
//          chat sync while preserving an auditable import history.
// Layer: Server import helper

import type {
  ServerSettings,
  ServerSettingsPatch,
  WorkspaceImportCategoryCounts,
  WorkspaceImportCategoryKind,
  WorkspaceImportHistoryEntry,
  WorkspaceImportApplyResult,
  WorkspaceImportSourceKind,
} from "@synara/contracts";
import {
  WORKSPACE_IMPORT_DEFAULT_CATEGORIES,
  normalizeWorkspaceImportSource,
} from "@synara/contracts";
import * as nodePath from "node:path";
import { planChatSync, type ChatSyncPlanItem } from "./chatSync";
import { collectImportChats, readSourceSettings, type CollectedImportChat } from "./chats";
import { appendWorkspaceImportHistory, writeWorkspaceImportSync } from "./history";
import {
  readWorkspaceImportLedger,
  upsertWorkspaceImportLedgerEntry,
  writeWorkspaceImportLedger,
  type WorkspaceImportLedger,
} from "./ledger";
import { absorbHonorAbleSettings, mergeAbsorbedSettings } from "./settingsAbsorb";
import {
  copyImportResources,
  discoverImportProjectRoots,
  discoverImportResources,
} from "./resources";
import { copyImportSkills, discoverImportSkills } from "./skills";

export interface WorkspaceImportApplyContext {
  readonly sources: readonly WorkspaceImportSourceKind[];
  readonly homeDir: string;
  readonly mossBaseDir: string;
  readonly mossCwd: string;
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now: Date;
  readonly currentSettings: ServerSettings;
  readonly existingThreadIds: ReadonlySet<string>;
  readonly createThreadId: (chat?: CollectedImportChat) => string;
  readonly categories?: readonly WorkspaceImportCategoryKind[] | undefined;
  readonly keepInSync?: boolean | undefined;
}

export interface WorkspaceImportPreparedApply {
  readonly result: WorkspaceImportApplyResult;
  readonly settingsPatch: ServerSettingsPatch;
  readonly chatPlans: readonly ChatSyncPlanItem[];
  readonly ledger: WorkspaceImportLedger;
  readonly historyEntry: WorkspaceImportHistoryEntry;
  /** Existing local workspace folders represented by the source project index. */
  readonly projectRoots: readonly string[];
}

export async function prepareWorkspaceImportApply(
  context: WorkspaceImportApplyContext,
): Promise<WorkspaceImportPreparedApply> {
  const uniqueSources = [
    ...new Set(context.sources.map((source) => normalizeWorkspaceImportSource(source))),
  ];
  const selectedCategories = new Set<WorkspaceImportCategoryKind>(
    context.categories === undefined ? WORKSPACE_IMPORT_DEFAULT_CATEGORIES : context.categories,
  );
  const discoveredSkills = (
    selectedCategories.has("skills")
      ? await Promise.all(
          uniqueSources.map((source) =>
            discoverImportSkills({
              source,
              homeDir: context.homeDir,
              platform: context.platform,
              env: context.env,
            }),
          ),
        )
      : []
  ).flat();
  const skills = selectedCategories.has("skills")
    ? await copyImportSkills({ skills: discoveredSkills, mossBaseDir: context.mossBaseDir })
    : [];

  const resourceCategoriesSelected = [
    "agents",
    "commands",
    "hooks",
    "mcp",
    "plugins",
    "memory",
  ].some((category) => selectedCategories.has(category as WorkspaceImportCategoryKind));
  const inventories = resourceCategoriesSelected
    ? await Promise.all(
        uniqueSources.map((source) =>
          discoverImportResources({
            source,
            homeDir: context.homeDir,
            platform: context.platform,
            env: context.env,
          }),
        ),
      )
    : [];
  const resourceResults =
    selectedCategories.has("agents") ||
    selectedCategories.has("commands") ||
    selectedCategories.has("hooks") ||
    selectedCategories.has("mcp") ||
    selectedCategories.has("plugins") ||
    selectedCategories.has("memory")
      ? await copyImportResources({
          resources: inventories.flatMap((inventory) => inventory.resources),
          destinationRoot: nodePath.join(context.stateDir, "imports"),
          selectedCategories,
        })
      : [];

  const discoveredProjectRoots = selectedCategories.has("projects")
    ? (
        await Promise.all(
          uniqueSources.map((source) =>
            discoverImportProjectRoots({
              source,
              homeDir: context.homeDir,
              platform: context.platform,
              env: context.env,
              fallbackCwd: context.mossCwd,
            }),
          ),
        )
      ).flat()
    : [];

  const absorbed = selectedCategories.has("settings")
    ? mergeAbsorbedSettings(
        await Promise.all(
          uniqueSources.map(async (source) =>
            absorbHonorAbleSettings({
              source,
              raw: await readSourceSettings({
                source,
                homeDir: context.homeDir,
                platform: context.platform,
                env: context.env,
              }),
              current: context.currentSettings,
            }),
          ),
        ),
      )
    : { patch: {}, changes: [], clientPreferences: {} };

  const collectedChats: CollectedImportChat[] = [];
  let skippedOlderChatCount = 0;
  for (const source of uniqueSources) {
    if (!selectedCategories.has("chats")) break;
    const chats = await collectImportChats({
      source,
      homeDir: context.homeDir,
      platform: context.platform,
      env: context.env,
      now: context.now,
      fallbackCwd: context.mossCwd,
    });
    collectedChats.push(...chats.chats);
    skippedOlderChatCount += chats.olderChatCount;
  }

  const projectRoots = [
    ...new Set([
      ...discoveredProjectRoots,
      ...(selectedCategories.has("chats")
        ? collectedChats.map((chat) => chat.workingDirectory)
        : []),
    ]),
  ];

  const ledger = await readWorkspaceImportLedger(context.stateDir);
  const nowIso = context.now.toISOString();
  const chatPlans = planChatSync({
    chats: collectedChats,
    ledger,
    existingThreadIds: context.existingThreadIds,
    nowIso,
    createThreadId: context.createThreadId,
  });

  let nextLedger: WorkspaceImportLedger = { version: 1, entries: { ...ledger.entries } };
  const chatResults = chatPlans.map((plan) => {
    nextLedger = upsertWorkspaceImportLedgerEntry(nextLedger, plan.ledgerEntry);
    return {
      source: plan.chat.source,
      sourceId: plan.chat.sourceId,
      threadId: plan.threadId,
      title: plan.chat.title,
      workingDirectory: plan.chat.workingDirectory,
      action: plan.action,
      connectors: [...plan.chat.connectors],
    };
  });

  const connectors = [...new Set(chatResults.flatMap((chat) => chat.connectors))];

  const categoryCounts = buildCategoryCounts({
    skills,
    resources: resourceResults,
    settings: absorbed.changes,
    chats: chatResults,
    projectCount: projectRoots.length,
  });
  const importedCount =
    projectRoots.length +
    skills.filter((item) => item.action === "copied" || item.action === "updated").length +
    resourceResults.filter((item) => item.action !== "unchanged" && item.action !== "skipped")
      .length +
    absorbed.changes.filter((item) => item.action === "applied").length +
    chatResults.filter((item) => item.action !== "unchanged").length;
  const failedCount =
    resourceResults.filter((item) => item.action === "skipped").length +
    skills.filter((item) => item.action === "skipped").length;
  const warningCount = resourceResults.filter((item) => item.reviewRequired === true).length;
  const historyEntry: WorkspaceImportHistoryEntry = {
    id: `import-${context.now.getTime()}-${crypto.randomUUID().slice(0, 8)}`,
    sources: uniqueSources,
    importedAt: nowIso,
    status: failedCount > 0 ? (importedCount > 0 ? "partial" : "failed") : "success",
    importedCount,
    failedCount,
    warningCount,
    categories: categoryCounts,
  };

  return {
    result: {
      skills,
      settings: absorbed.changes,
      clientPreferences: absorbed.clientPreferences,
      chats: chatResults,
      connectors,
      skippedOlderChatCount,
      resources: resourceResults,
      categories: categoryCounts,
      historyEntry,
      warnings:
        warningCount > 0
          ? [
              "Hooks, MCP servers and plugins were copied for review only; Moss did not execute them.",
            ]
          : [],
    },
    settingsPatch: absorbed.patch,
    chatPlans,
    ledger: nextLedger,
    historyEntry,
    projectRoots,
  };
}

export async function persistWorkspaceImportLedger(
  stateDir: string,
  ledger: WorkspaceImportLedger,
): Promise<void> {
  await writeWorkspaceImportLedger(stateDir, ledger);
}

export async function persistWorkspaceImportHistory(
  stateDir: string,
  entry: WorkspaceImportHistoryEntry,
): Promise<void> {
  await appendWorkspaceImportHistory(stateDir, entry);
}

export async function persistWorkspaceImportSyncPreferences(input: {
  readonly stateDir: string;
  readonly enabled: boolean;
  readonly categories: readonly WorkspaceImportCategoryKind[];
  readonly sources: readonly WorkspaceImportSourceKind[];
  readonly now: Date;
}) {
  return writeWorkspaceImportSync(input.stateDir, input);
}

function buildCategoryCounts(input: {
  readonly skills: readonly { action: string }[];
  readonly resources: readonly {
    category: WorkspaceImportCategoryKind;
    action: string;
    reviewRequired?: boolean;
  }[];
  readonly settings: readonly { action: string }[];
  readonly chats: readonly { action: string }[];
  readonly projectCount: number;
}): WorkspaceImportCategoryCounts {
  const counts = {
    settings: input.settings.filter((item) => item.action === "applied").length,
    skills: input.skills.filter((item) => item.action === "copied" || item.action === "updated")
      .length,
    agents: 0,
    commands: 0,
    hooks: 0,
    mcp: 0,
    plugins: 0,
    memory: 0,
    projects: input.projectCount,
    chats: input.chats.filter((item) => item.action !== "unchanged").length,
  } as Record<WorkspaceImportCategoryKind, number>;
  for (const resource of input.resources) {
    if (resource.action === "skipped") continue;
    counts[resource.category] += 1;
  }
  return counts as WorkspaceImportCategoryCounts;
}
