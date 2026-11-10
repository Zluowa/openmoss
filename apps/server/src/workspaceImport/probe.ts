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
} from "@moss/contracts";
import { collectImportChats, inspectCodexChatInventory, readSourceSettings } from "./chats";
import { readWorkspaceImportHistory, readWorkspaceImportSync } from "./history";
import { canonicalWorkspaceImportSources, workspaceImportProviderForSource } from "./providers";
import { countImportProjects, discoverImportResources, emptyCounts } from "./resources";
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
  /** Skip chats and projects (see `WorkspaceImportProbeInput.scope`). */
  readonly toolsOnly?: boolean | undefined;
  /** How long one probe step of one source may take before it is reported as unfinished. */
  readonly stepTimeoutMs?: number | undefined;
  /** Called once per source when its probe settles, for the server log. */
  readonly onSourceProbed?: ((event: WorkspaceImportSourceProbeEvent) => void) | undefined;
}

export interface WorkspaceImportSourceProbeEvent {
  readonly source: WorkspaceImportSourceKind;
  readonly durationMs: number;
  /** Steps that ran out of time; their counts are missing from the preview. */
  readonly timedOutSteps: readonly string[];
  /** Steps that threw; their counts are missing from the preview. */
  readonly failedSteps: readonly string[];
  /** How long each step took, cut-off steps included (at the cut-off time). */
  readonly stepDurationsMs: Readonly<Record<string, number>>;
}

/**
 * The web client gives up on an RPC after 60 s. Every step of every source runs at
 * once and each is cut off after this long, so the probe answers well inside that
 * window even when one provider's history is huge or on a slow disk. A cut-off
 * step keeps running in the background; its source is marked incomplete.
 */
export const WORKSPACE_IMPORT_PROBE_STEP_TIMEOUT_MS = 12_000;

/**
 * Settings → Import's configuration read (`toolsOnly`) runs beside the conversation scan,
 * which has the disk to itself for a while on a cold start. Its steps are small, so they
 * get longer to finish rather than coming back as zeros: still well inside the RPC's 60 s.
 */
export const WORKSPACE_IMPORT_TOOLS_PROBE_STEP_TIMEOUT_MS = 30_000;

export function workspaceImportProbeStepTimeoutMs(
  context: Pick<WorkspaceImportProbeContext, "stepTimeoutMs" | "toolsOnly">,
): number {
  return (
    context.stepTimeoutMs ??
    (context.toolsOnly
      ? WORKSPACE_IMPORT_TOOLS_PROBE_STEP_TIMEOUT_MS
      : WORKSPACE_IMPORT_PROBE_STEP_TIMEOUT_MS)
  );
}

type StepOutcome<T> = (
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "timedOut" }
  | { readonly kind: "failed" }
) & { readonly durationMs: number };

async function runStep<T>(work: () => Promise<T>, timeoutMs: number): Promise<StepOutcome<T>> {
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<StepOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timedOut", durationMs: elapsed() }), timeoutMs);
  });
  try {
    return await Promise.race([
      work().then(
        (value): StepOutcome<T> => ({ kind: "done", value, durationMs: elapsed() }),
        (): StepOutcome<T> => ({ kind: "failed", durationMs: elapsed() }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
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

async function probeSource(
  source: WorkspaceImportSourceKind,
  context: WorkspaceImportProbeContext,
): Promise<WorkspaceImportSourcePreview> {
  const pathInput = {
    homeDir: context.homeDir,
    platform: context.platform,
    env: context.env,
  } as const;
  const startedAt = performance.now();
  const timeoutMs = workspaceImportProbeStepTimeoutMs(context);
  const timedOutSteps: string[] = [];
  const failedSteps: string[] = [];
  const stepDurationsMs: Record<string, number> = {};
  const settle = <T>(step: string, outcome: StepOutcome<T>, fallback: T): T => {
    stepDurationsMs[step] = outcome.durationMs;
    if (outcome.kind === "done") return outcome.value;
    (outcome.kind === "timedOut" ? timedOutSteps : failedSteps).push(step);
    return fallback;
  };
  const [skillsStep, settingsStep, chatsStep, resourcesStep, projectsStep] = await Promise.all([
    runStep(() => discoverImportSkills({ source, ...pathInput }), timeoutMs),
    runStep(() => readSourceSettings({ source, ...pathInput }), timeoutMs),
    runStep(
      async () =>
        context.toolsOnly
          ? { chatCount: 0, olderChatCount: 0 }
          : source === "codex"
            ? await inspectCodexChatInventory({ ...pathInput, now: context.now })
            : await collectImportChats({
                source,
                ...pathInput,
                now: context.now,
                fallbackCwd: context.mossCwd,
                countOnly: true,
              }),
      timeoutMs,
    ),
    runStep(() => discoverImportResources({ source, ...pathInput, countOnly: true }), timeoutMs),
    runStep(
      async () =>
        context.toolsOnly
          ? 0
          : await countImportProjects({ source, ...pathInput, fallbackCwd: context.mossCwd }),
      timeoutMs,
    ),
  ]);
  const skills = settle("skills", skillsStep, []);
  const settingsRaw = settle("settings", settingsStep, null);
  const chatInventory = settle("chats", chatsStep, { chatCount: 0, olderChatCount: 0 });
  const resources = settle("resources", resourcesStep, { resources: [], counts: emptyCounts() });
  const projectCount = settle("projects", projectsStep, 0);
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
  const incomplete = timedOutSteps.length > 0 || failedSteps.length > 0;
  const present =
    skills.length > 0 ||
    settingsRaw !== null ||
    chatCount > 0 ||
    resources.resources.length > 0 ||
    projectCount > 0 ||
    // A source whose data folder exists but could not be read in time is still
    // there; leaving it out would make a slow history look like no history.
    (incomplete && detectedPath !== null);
  context.onSourceProbed?.({
    source,
    durationMs: Math.round(performance.now() - startedAt),
    timedOutSteps,
    failedSteps,
    stepDurationsMs,
  });
  return {
    source,
    present,
    ...(incomplete ? { incomplete: true } : {}),
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
  // Every source runs at once: each one's own reads are bounded (file counts, byte
  // budgets, step deadlines), so the total is the slowest source, not the sum.
  const sources = await Promise.all(
    canonicalWorkspaceImportSources().map((source) => probeSource(source, context)),
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
