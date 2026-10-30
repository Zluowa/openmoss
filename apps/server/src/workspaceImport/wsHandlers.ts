import { orderChatPlansForReplay } from "./chatSync";
import { projectCodexSnapshotHistory } from "../orchestration/codexReplay";
// FILE: wsHandlers.ts
// Purpose: WebSocket handlers that probe and apply workspace import.
// Layer: Server RPC adapter

import { createHash } from "node:crypto";
import * as nodePath from "node:path";

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type ServerSettingsPatch,
  type WorkspaceImportApplyInput,
  type WorkspaceImportApplyResult,
  type WorkspaceImportProjectCopy,
  type WorkspaceImportSourceKind,
  normalizeWorkspaceImportSource,
  type WorkspaceImportProbeInput,
  type WorkspaceImportProbeResult,
  type WorkspaceImportSyncInput,
} from "@synara/contracts";
import { defaultInstanceIdForProvider } from "@synara/shared/providerInstances";
import { Effect, Option, Semaphore } from "effect";

import type { ServerConfigShape } from "../config";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery";
import { protectReservedSettingsPatch } from "../reservedSettingsBoundary";
import type { ServerSettingsShape } from "../serverSettings";
import {
  CurrentManagedAttachmentPrincipal,
  LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
} from "../managedAttachmentPrincipal";
import { CurrentWsSessionRole } from "../wsConnectionSessions";
import {
  persistWorkspaceImportHistory,
  persistWorkspaceImportLedger,
  persistWorkspaceImportSyncPreferences,
  prepareWorkspaceImportApply,
} from "./apply";
import { readWorkspaceImportLedger } from "./ledger";
import { readWorkspaceImportSync } from "./history";
import { probeWorkspaceImport } from "./probe";
import { sanitizeImportSettingsPatch } from "./settingsAbsorb";

function parseNow(value: string | undefined): Date {
  if (!value) {
    return new Date();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function stableImportUuid(source: WorkspaceImportSourceKind, sourceId: string): string {
  const bytes = createHash("sha256")
    .update(`moss:workspace-import:thread:${normalizeWorkspaceImportSource(source)}:${sourceId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  // UUIDv5-shaped deterministic ids make a retry after a partial dispatch
  // converge on the same thread instead of creating a duplicate.
  bytes[12] = "5";
  bytes[16] = ((Number.parseInt(bytes[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  return [
    bytes.slice(0, 8).join(""),
    bytes.slice(8, 12).join(""),
    bytes.slice(12, 16).join(""),
    bytes.slice(16, 20).join(""),
    bytes.slice(20, 32).join(""),
  ].join("-");
}

function stableProjectUuid(workspaceRoot: string): string {
  const bytes = createHash("sha256")
    .update(`moss:workspace-import:project:${nodePath.resolve(workspaceRoot)}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  bytes[12] = "5";
  bytes[16] = ((Number.parseInt(bytes[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  return [
    bytes.slice(0, 8).join(""),
    bytes.slice(8, 12).join(""),
    bytes.slice(12, 16).join(""),
    bytes.slice(16, 20).join(""),
    bytes.slice(20, 32).join(""),
  ].join("-");
}

function stableCommandUuid(seed: string): string {
  const bytes = createHash("sha256")
    .update(`moss:workspace-import:command:${seed}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  bytes[12] = "5";
  bytes[16] = ((Number.parseInt(bytes[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  return [
    bytes.slice(0, 8).join(""),
    bytes.slice(8, 12).join(""),
    bytes.slice(12, 16).join(""),
    bytes.slice(16, 20).join(""),
    bytes.slice(20, 32).join(""),
  ].join("-");
}

function projectTitleForWorkspace(workspaceRoot: string): string {
  const base = nodePath.basename(workspaceRoot.trim());
  return base.length > 0 ? base : "Imported project";
}

function pathContainedBy(candidate: string, root: string): boolean {
  const resolvedCandidate = nodePath.resolve(candidate);
  const resolvedRoot = nodePath.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${nodePath.sep}`)
  );
}

function safeWorkspaceRoot(candidate: string, config: ServerConfigShape): string {
  const fallback = nodePath.resolve(config.cwd);
  const value = candidate.trim();
  if (!value || value.includes("\0") || !nodePath.isAbsolute(value)) return fallback;
  const resolved = nodePath.resolve(value);
  // Import metadata is untrusted. Keep project creation inside the user's
  // home or the configured Moss workspace; callers must not widen this allow
  // list with paths read from provider transcripts.
  const approved = [config.homeDir, fallback];
  return approved.some((root) => pathContainedBy(resolved, root)) ? resolved : fallback;
}

function providerForSource(
  source: WorkspaceImportApplyInput["sources"][number],
): "codex" | "claudeAgent" | "cursor" | "grok" | "opencode" {
  switch (normalizeWorkspaceImportSource(source)) {
    case "claude":
      return "claudeAgent";
    case "cursor":
      return "cursor";
    case "grok":
      return "grok";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
  }
}

const WORKSPACE_IMPORT_AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1_000;
const WORKSPACE_IMPORT_AUTO_SYNC_START_DELAY_MS = 10_000;

export function makeWorkspaceImportWsHandlers(input: {
  readonly config: ServerConfigShape;
  readonly serverSettings: ServerSettingsShape;
  readonly projectionReadModelQuery: ProjectionSnapshotQueryShape;
  readonly dispatchOrchestrationCommand: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, unknown>;
}) {
  const requireOwner = Effect.gen(function* () {
    const role = yield* CurrentWsSessionRole;
    const attachmentPrincipal = yield* CurrentManagedAttachmentPrincipal;
    if (role !== "owner" && attachmentPrincipal.ownerKind !== "local-loopback") {
      return yield* Effect.fail(new Error("Workspace import requires the owner session."));
    }
  });
  const probeSemaphore = Semaphore.makeUnsafe(1);

  const probe = (request: WorkspaceImportProbeInput = {}) =>
    probeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* requireOwner;
        const currentSettings = yield* input.serverSettings.getSettings;
        return yield* Effect.tryPromise({
          try: () =>
            probeWorkspaceImport({
              homeDir: input.config.homeDir,
              mossCwd: input.config.cwd,
              platform: process.platform,
              env: process.env,
              now: parseNow(request.now),
              currentSettings,
              stateDir: input.config.stateDir,
            }),
          catch: (error) =>
            new Error(error instanceof Error ? error.message : "Failed to probe workspace import"),
        });
      }),
    );

  const applyUnlocked = (request: WorkspaceImportApplyInput) =>
    Effect.gen(function* () {
      yield* requireOwner;
      const currentSettings = yield* input.serverSettings.getSettings;
      const ledger = yield* Effect.tryPromise({
        try: () => readWorkspaceImportLedger(input.config.stateDir),
        catch: (error) =>
          new Error(error instanceof Error ? error.message : "Failed to read import ledger"),
      });
      const existingThreadIds = new Set<string>();
      for (const entry of Object.values(ledger.entries)) {
        const thread = yield* input.projectionReadModelQuery.getThreadShellById(
          ThreadId.makeUnsafe(entry.threadId),
        );
        if (Option.isSome(thread)) {
          existingThreadIds.add(entry.threadId);
        }
      }

      const prepared = yield* Effect.tryPromise({
        try: () =>
          prepareWorkspaceImportApply({
            sources: request.sources,
            homeDir: input.config.homeDir,
            mossBaseDir: input.config.baseDir,
            mossCwd: input.config.cwd,
            stateDir: input.config.stateDir,
            platform: process.platform,
            env: process.env,
            now: parseNow(request.now),
            currentSettings,
            existingThreadIds,
            createThreadId: (chat) =>
              chat ? stableImportUuid(chat.source, chat.sourceId) : crypto.randomUUID(),
            categories: request.categories,
            keepInSync: request.keepInSync,
          }),
        catch: (error) =>
          new Error(error instanceof Error ? error.message : "Failed to prepare workspace import"),
      });

      const orderedChatPlans = yield* Effect.try({
        try: () => orderChatPlansForReplay(prepared.chatPlans),
        catch: (error) =>
          new Error(error instanceof Error ? error.message : "Failed to order imported chats"),
      });

      const settingsPatch = sanitizeImportSettingsPatch(prepared.settingsPatch, {
        allowCodexSafeSettings: true,
      });
      if (hasSettingsPatch(settingsPatch)) {
        yield* input.serverSettings.updateSettingsView(
          protectReservedSettingsPatch(currentSettings, settingsPatch),
        );
      }

      const nowIso = parseNow(request.now).toISOString();
      const projectIdsByWorkspace = new Map<string, ProjectId>();
      const projectCopies: WorkspaceImportProjectCopy[] = [];

      const nativeThreadIds = new Map(
        prepared.chatPlans.flatMap((plan) =>
          plan.chat.nativeThreadId ? [[plan.chat.nativeThreadId, plan.threadId] as const] : [],
        ),
      );
      for (const importedRoot of prepared.projectRoots) {
        const workspaceRoot = safeWorkspaceRoot(importedRoot, input.config);
        const key = nodePath.resolve(workspaceRoot);
        if (projectIdsByWorkspace.has(key)) continue;
        const project = yield* findOrCreateProject({
          workspaceRoot,
          fallbackWorkspaceRoot: input.config.cwd,
          nowIso,
          projectionReadModelQuery: input.projectionReadModelQuery,
          dispatchOrchestrationCommand: input.dispatchOrchestrationCommand,
        });
        projectIdsByWorkspace.set(key, project.id);
        projectCopies.push({ path: workspaceRoot, action: project.action });
      }

      for (const plan of orderedChatPlans) {
        const workspaceRoot = safeWorkspaceRoot(
          plan.chat.workingDirectory.trim() || input.config.cwd,
          input.config,
        );
        const key = nodePath.resolve(workspaceRoot);
        let projectId = projectIdsByWorkspace.get(key);
        if (!projectId) {
          const project = yield* findOrCreateProject({
            workspaceRoot,
            fallbackWorkspaceRoot: input.config.cwd,
            nowIso,
            projectionReadModelQuery: input.projectionReadModelQuery,
            dispatchOrchestrationCommand: input.dispatchOrchestrationCommand,
          });
          projectId = project.id;
          projectCopies.push({ path: workspaceRoot, action: project.action });
          projectIdsByWorkspace.set(key, projectId);
        }
        if (plan.action === "created") {
          const provider = providerForSource(plan.chat.source);
          yield* input.dispatchOrchestrationCommand({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(stableCommandUuid(`thread-create:${plan.threadId}`)),
            threadId: ThreadId.makeUnsafe(plan.threadId),
            projectId,
            title: plan.chat.title,
            modelSelection: {
              provider,
              instanceId: defaultInstanceIdForProvider(provider),
              model: DEFAULT_MODEL_BY_PROVIDER[provider],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            envMode: "local",
            branch: null,
            worktreePath: null,
            workingDirectory: workspaceRoot,
            ...(plan.chat.nativeParentThreadId &&
            nativeThreadIds.has(plan.chat.nativeParentThreadId)
              ? {
                  parentThreadId: ThreadId.makeUnsafe(
                    nativeThreadIds.get(plan.chat.nativeParentThreadId)!,
                  ),
                  subagentAgentId: plan.chat.nativeThreadId ?? null,
                  subagentNickname:
                    plan.chat.nativeAgentNickname ??
                    plan.chat.nativeAgentPath?.split("/").at(-1) ??
                    null,
                }
              : {}),
            createdAt: nowIso,
          });
        } else if (plan.action === "updated") {
          yield* input.dispatchOrchestrationCommand({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(
              stableCommandUuid(`thread-meta:${plan.threadId}:${plan.chat.updatedAt}`),
            ),
            threadId: ThreadId.makeUnsafe(plan.threadId),
            title: plan.chat.title,
            workingDirectory: workspaceRoot,
          });
        }
        if (
          plan.action !== "created" &&
          plan.chat.nativeParentThreadId &&
          nativeThreadIds.has(plan.chat.nativeParentThreadId)
        ) {
          const parentThreadId = ThreadId.makeUnsafe(
            nativeThreadIds.get(plan.chat.nativeParentThreadId)!,
          );
          yield* input.dispatchOrchestrationCommand({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(
              stableCommandUuid(`thread-replay-parent:${plan.threadId}:${parentThreadId}`),
            ),
            threadId: ThreadId.makeUnsafe(plan.threadId),
            parentThreadId,
            subagentAgentId: plan.chat.nativeThreadId ?? null,
            subagentNickname:
              plan.chat.nativeAgentNickname ?? plan.chat.nativeAgentPath?.split("/").at(-1) ?? null,
          });
        }
        if (plan.chat.codexHistory && plan.action !== "unchanged") {
          yield* input.dispatchOrchestrationCommand({
            type: "thread.history.import",
            commandId: CommandId.makeUnsafe(
              stableCommandUuid(`thread-replay:${plan.threadId}:${plan.chat.replayFingerprint}`),
            ),
            threadId: ThreadId.makeUnsafe(plan.threadId),
            entries: projectCodexSnapshotHistory({
              threadId: ThreadId.makeUnsafe(plan.threadId),
              importedAt: nowIso,
              turns: plan.chat.codexHistory,
              // Retain the ids used by earlier workspace text imports when
              // upgrading the same thread to canonical replay.
              messageIdAtIndex: (index) =>
                MessageId.makeUnsafe(`workspace-import:${plan.threadId}:${index}`),
            }),
            createdAt: nowIso,
          });
        } else if (!plan.chat.codexHistory && plan.messagesToImport.length > 0) {
          yield* input.dispatchOrchestrationCommand({
            type: "thread.messages.import",
            commandId: CommandId.makeUnsafe(
              stableCommandUuid(
                `thread-messages:${plan.threadId}:${plan.ledgerEntry.importedCount}`,
              ),
            ),
            threadId: ThreadId.makeUnsafe(plan.threadId),
            messages: plan.messagesToImport.map((message, index) => ({
              messageId: MessageId.makeUnsafe(
                `workspace-import:${plan.threadId}:${plan.ledgerEntry.importedCount - plan.messagesToImport.length + index}`,
              ),
              role: message.role,
              text: message.text,
              createdAt: message.createdAt,
              updatedAt: message.createdAt,
            })),
            createdAt: nowIso,
          });
        }
      }

      yield* Effect.tryPromise({
        try: () => persistWorkspaceImportLedger(input.config.stateDir, prepared.ledger),
        catch: (error) =>
          new Error(error instanceof Error ? error.message : "Failed to persist import ledger"),
      });

      yield* Effect.tryPromise({
        try: () => persistWorkspaceImportHistory(input.config.stateDir, prepared.historyEntry),
        catch: (error) =>
          new Error(error instanceof Error ? error.message : "Failed to persist import history"),
      });
      let syncWarning: string | undefined;
      if (request.keepInSync === true) {
        const syncSaved = yield* Effect.tryPromise({
          try: async () => {
            const currentSync = await readWorkspaceImportSync(input.config.stateDir);
            await persistWorkspaceImportSyncPreferences({
              stateDir: input.config.stateDir,
              enabled: true,
              categories: [
                ...new Set([
                  ...currentSync.categories,
                  ...(request.categories ?? ["settings", "skills", "agents", "projects", "chats"]),
                ]),
              ],
              sources: [...new Set([...currentSync.sources, ...request.sources])],
              now: parseNow(request.now),
            });
            return true;
          },
          catch: () => false,
        });
        if (!syncSaved) {
          syncWarning = "Import completed, but automatic-sync preferences could not be saved.";
        }
      }
      return {
        ...prepared.result,
        projects: projectCopies,
        ...(syncWarning ? { warnings: [...(prepared.result.warnings ?? []), syncWarning] } : {}),
      };
    });

  // A single server can receive two renderer clicks before the first import
  // has flushed its ledger. Serialize the whole read/dispatch/persist cycle so
  // the second run observes the first ledger and cannot create duplicate
  // projects, threads, or messages.
  // Keep the entire read/dispatch/persist cycle in the caller's Effect fiber.
  // A Promise chain plus Effect.runPromise would drop connection-scoped
  // services (notably the owner role and attachment principal).
  const applySemaphore = Semaphore.makeUnsafe(1);
  const apply = (request: WorkspaceImportApplyInput) =>
    applySemaphore.withPermits(1)(
      Effect.gen(function* () {
        // Check before entering the failure journal so an unauthorized caller
        // cannot manufacture import-history records.
        yield* requireOwner;
        return yield* applyUnlocked(request).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const now = parseNow(request.now);
              const failedEntry = {
                id: `import-failed-${now.getTime()}-${crypto.randomUUID().slice(0, 8)}`,
                sources: [...new Set(request.sources.map(normalizeWorkspaceImportSource))],
                importedAt: now.toISOString(),
                status: "failed" as const,
                importedCount: 0,
                failedCount: 1,
                warningCount: 0,
                categories: {
                  settings: 0,
                  skills: 0,
                  agents: 0,
                  commands: 0,
                  hooks: 0,
                  mcp: 0,
                  plugins: 0,
                  memory: 0,
                  projects: 0,
                  chats: 0,
                },
              } satisfies import("@synara/contracts").WorkspaceImportHistoryEntry;
              yield* Effect.tryPromise({
                try: () => persistWorkspaceImportHistory(input.config.stateDir, failedEntry),
                catch: () => undefined,
              }).pipe(Effect.catch(() => Effect.void));
              return yield* Effect.fail(
                error instanceof Error ? error : new Error("Workspace import failed"),
              );
            }),
          ),
        );
      }),
    );

  let disposed = false;
  let automaticSyncRunning = false;
  const runAutomaticSync = async (): Promise<void> => {
    if (disposed || automaticSyncRunning) return;
    automaticSyncRunning = true;
    try {
      const preferences = await readWorkspaceImportSync(input.config.stateDir);
      if (
        !preferences.enabled ||
        preferences.sources.length === 0 ||
        preferences.categories.length === 0
      ) {
        return;
      }
      await Effect.runPromise(
        apply({
          sources: preferences.sources,
          categories: preferences.categories,
          // The timer is already driven by persisted preferences. Do not ask
          // this background pass to re-enable sync when a user disables it
          // after the initial preference read but before apply() acquires the
          // semaphore.
          keepInSync: false,
          now: new Date().toISOString(),
        }).pipe(
          Effect.provideService(CurrentWsSessionRole, "owner"),
          Effect.provideService(
            CurrentManagedAttachmentPrincipal,
            LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          ),
        ),
      );
    } catch {
      // apply() records a durable failed history entry after authorization.
      // The next bounded interval retries without crashing the server.
    } finally {
      automaticSyncRunning = false;
    }
  };

  const scheduleAutomaticSync = (delay: number): NodeJS.Timeout => {
    const timer = setTimeout(() => void runAutomaticSync(), delay);
    timer.unref();
    return timer;
  };

  const sync = (request: WorkspaceImportSyncInput) =>
    // Serialize preference writes with apply(). Otherwise a stop-sync request
    // can commit while an import is running and be overwritten by apply's
    // keepInSync finalizer, silently re-enabling the background timer.
    applySemaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* requireOwner;
        const preferences = yield* Effect.tryPromise({
          try: () =>
            persistWorkspaceImportSyncPreferences({
              stateDir: input.config.stateDir,
              enabled: request.enabled,
              categories: request.categories,
              sources: request.sources,
              now: parseNow(request.now),
            }),
          catch: (error) =>
            new Error(error instanceof Error ? error.message : "Failed to persist sync settings"),
        });
        if (preferences.enabled) {
          yield* Effect.sync(() => {
            scheduleAutomaticSync(0);
          });
        }
        return preferences;
      }),
    );

  const startupSyncTimer = scheduleAutomaticSync(WORKSPACE_IMPORT_AUTO_SYNC_START_DELAY_MS);
  const interval = setInterval(
    () => void runAutomaticSync(),
    WORKSPACE_IMPORT_AUTO_SYNC_INTERVAL_MS,
  );
  interval.unref();

  const dispose = () => {
    disposed = true;
    clearTimeout(startupSyncTimer);
    clearInterval(interval);
  };

  return {
    probe,
    apply,
    sync,
    dispose,
  };
}

function hasSettingsPatch(patch: ServerSettingsPatch): boolean {
  return Object.keys(patch).length > 0;
}

function findOrCreateProject(input: {
  readonly workspaceRoot: string;
  readonly fallbackWorkspaceRoot: string;
  readonly nowIso: string;
  readonly projectionReadModelQuery: ProjectionSnapshotQueryShape;
  readonly dispatchOrchestrationCommand: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, unknown>;
}) {
  return Effect.gen(function* () {
    const preferredRoot = input.workspaceRoot.trim() || input.fallbackWorkspaceRoot;
    const existing =
      yield* input.projectionReadModelQuery.getActiveProjectByWorkspaceRoot(preferredRoot);
    if (Option.isSome(existing)) {
      return { id: existing.value.id, action: "existing" as const };
    }
    if (preferredRoot === input.fallbackWorkspaceRoot) {
      const fallback = yield* input.projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        input.fallbackWorkspaceRoot,
      );
      if (Option.isSome(fallback)) {
        return { id: fallback.value.id, action: "existing" as const };
      }
    }
    const workspaceRoot = preferredRoot;
    const projectId = ProjectId.makeUnsafe(stableProjectUuid(workspaceRoot));
    yield* input.dispatchOrchestrationCommand({
      type: "project.create",
      commandId: CommandId.makeUnsafe(stableCommandUuid(`project-create:${projectId}`)),
      projectId,
      title: projectTitleForWorkspace(workspaceRoot),
      workspaceRoot,
      createWorkspaceRootIfMissing: false,
      createdAt: input.nowIso,
    });
    return { id: projectId, action: "created" as const };
  });
}

export type { WorkspaceImportApplyResult, WorkspaceImportProbeResult };
