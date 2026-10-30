// FILE: usePluginResourceActions.ts
// Purpose: The real interaction handlers behind the Plugins/MCP/Skills cards and
//          detail modal. Provider plugins use the native lifecycle while
//          `.moss` plugins remain on canonical resource APIs.
// Layer: Web lib (hook)
// Exports: usePluginResourceActions

import type {
  MossCanonicalResourceMutationPrepareInput,
  ProjectId,
  ProviderAppInfo,
  ProviderInstanceId,
  ProviderInstallPluginResult,
  SupportedProviderKind,
  ProviderMcpServerDescriptor,
  ProviderPluginInstallAppSummary,
  ProviderPluginDescriptor,
  ThreadId,
} from "@synara/contracts";
import { useCallback, useMemo, useRef } from "react";

import {
  getProviderInstanceOptions,
  getProviderStartOptions,
  resolveAssistantDeliveryMode,
  resolveNewConversationDefaultModelSelection,
  useAppSettings,
} from "~/appSettings";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { ensureNativeApi } from "~/nativeApi";
import type { ResourceDetail } from "~/components/PluginResourceDetailDialog";
import { ensureProjectId } from "./ensureProjectId";
import {
  canInstallPluginToHarness,
  isMossCanonicalMcp,
  isMossCanonicalSkill,
  mossCanonicalPluginManifestPath,
  pluginMutationOwner,
} from "./pluginLibraryModel";
import { buildAppComposerMention } from "./appToolsModel";
import { dispatchDraftThread, type DraftThreadDispatchResult } from "./draftThreadDispatch";
import {
  buildCreatorPrompt,
  buildTryInChatSeed,
  createSingleFlight,
  resolveCreatorTaskWorkspace,
} from "./tryInChatTarget";

/** Whether "Uninstall" (delete canonical) is available for this resource. */
export function canUninstallResource(resource: ResourceDetail): boolean {
  switch (resource.kind) {
    case "skill":
      return isMossCanonicalSkill(resource.skill);
    case "mcp":
      return isMossCanonicalMcp(resource.server);
    case "plugin":
      return pluginMutationOwner(resource.plugin) !== null;
  }
}

/** Whether the native provider can install this directory plugin. */
export function canInstallPluginResource(resource: ResourceDetail): boolean {
  return resource.kind === "plugin" && canInstallPluginToHarness(resource.plugin);
}

export function canTogglePluginResource(plugin: ProviderPluginDescriptor): boolean {
  return pluginMutationOwner(plugin) !== null;
}

export function canToggleMcpResource(server: ProviderMcpServerDescriptor): boolean {
  return isMossCanonicalMcp(server);
}

function resourceName(resource: ResourceDetail): string {
  switch (resource.kind) {
    case "skill":
      return resource.skill.interface?.displayName ?? resource.skill.name;
    case "mcp":
      return resource.server.name;
    case "plugin":
      return resource.plugin.interface?.displayName ?? resource.plugin.name;
  }
}

export function pluginMarketplaceSelector(
  resource: Extract<ResourceDetail, { kind: "plugin" }>,
): { marketplacePath: string } | { remoteMarketplaceName: string } | null {
  if (resource.marketplacePath) return { marketplacePath: resource.marketplacePath };
  if (resource.remoteMarketplaceName) {
    return { remoteMarketplaceName: resource.remoteMarketplaceName };
  }
  return null;
}

type CanonicalMutationPayload = Omit<MossCanonicalResourceMutationPrepareInput, "cwd">;

export interface PluginInstallActionResult {
  readonly created: true;
  readonly authPolicy: ProviderInstallPluginResult["authPolicy"];
  readonly appsNeedingAuth: ReadonlyArray<ProviderPluginInstallAppSummary>;
}

export function normalizePluginInstallActionResult(
  result: ProviderInstallPluginResult,
): PluginInstallActionResult {
  return {
    created: true,
    authPolicy: result.authPolicy,
    appsNeedingAuth: result.appsNeedingAuth,
  };
}

export interface ResourceDeleteActionResult {
  readonly removed: boolean;
}

export interface ResourceUpdateActionResult {
  readonly updated: boolean;
  readonly overridden?: boolean;
}

// Codex creates a skill/plugin by opening a fresh thread with the matching
// creator skill (`skill-creator` / `plugin-creator`) attached and a first-use
// prompt. Ported verbatim from the restored plugins-page `CREATOR_META` +
// `buildCreatorPrompt`, including the localStorage first-open flags.
export const CREATOR_META = {
  skill: {
    skillName: "skill-creator",
    firstUsePrompt: "help me create a skill",
    firstUseKey: "moss-has-opened-skill-creator-prefill-v1",
  },
  plugin: {
    skillName: "plugin-creator",
    firstUsePrompt: "help me create a plugin",
    firstUseKey: "moss-has-opened-plugin-creator-prefill-v1",
  },
} as const;

export type CreatorKind = keyof typeof CREATOR_META;

/**
 * Explicit opt-in for a Creator turn. The normal Plugins action only opens an
 * unsent draft; this path requires an already-created, task-owned workspace so
 * an automation cannot accidentally write into the user's active repository.
 */
export interface CreatorDispatchOptions {
  readonly taskWorkspace: string;
  /** Optional authored request; the built-in first-use request is the default. */
  readonly prompt?: string;
}

export interface CreatorDispatchActionResult {
  readonly threadId: ThreadId;
  readonly dispatch: DraftThreadDispatchResult;
}

function readFirstOpenFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}
function markFirstOpen(key: string): void {
  try {
    window.localStorage.setItem(key, "true");
  } catch {
    // A blocked localStorage just means the first-use prompt shows again.
  }
}

export function usePluginResourceActions(input: {
  activeProjectId: ProjectId | null;
  provider: SupportedProviderKind;
  instanceId: ProviderInstanceId | null;
  cwd: string | null;
}) {
  const { settings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  const defaultModelSelection = useMemo(() => {
    const selection = resolveNewConversationDefaultModelSelection(settings, input.provider);
    return input.instanceId ? { ...selection, instanceId: input.instanceId } : selection;
  }, [input.instanceId, input.provider, settings]);

  // Single-flight guard: opening a thread ensures/bootstraps a project and
  // navigates away, so a double-click (or a re-fire before React re-renders)
  // must not run twice — that would mint two draft threads and orphan the first
  // seeded prompt. A duplicate call resolves to `true` (handled, no error toast).
  const singleFlightRef = useRef(createSingleFlight());
  const runExclusive = singleFlightRef.current.run;
  const creatorDispatchFlightRef = useRef<Promise<CreatorDispatchActionResult | null> | null>(null);

  // Matches Codex "Try in chat": open a fresh thread and prefill the composer
  // with the resource's prompt (skills are additionally attached by reference).
  const tryInChat = useCallback(
    (resource: ResourceDetail, promptOverride?: string): Promise<boolean> =>
      runExclusive(async () => {
        const projectId = await ensureProjectId({
          activeProjectId: input.activeProjectId,
          cwd: input.cwd,
          defaultModelSelection,
        });
        if (!projectId) return false;
        const threadId = await handleNewThread(projectId, {
          provider: input.provider,
          ...(input.instanceId ? { providerInstanceId: input.instanceId } : {}),
          fresh: true,
        });
        if (!threadId) return false;
        // Mirror the composer picker: set the reference(s) AND the chip token in
        // the prompt. The reference alone is dropped on send unless its token is
        // present in the text (filterPromptSkillReferences / mention filter).
        const seed = buildTryInChatSeed(resource, input.provider, promptOverride);
        const store = useComposerDraftStore.getState();
        if (seed.skills.length > 0) store.setSkills(threadId, seed.skills);
        if (seed.mentions.length > 0) store.setMentions(threadId, seed.mentions);
        store.setPrompt(threadId, seed.prompt);
        return true;
      }),
    [
      runExclusive,
      defaultModelSelection,
      handleNewThread,
      input.activeProjectId,
      input.provider,
      input.instanceId,
      input.cwd,
    ],
  );

  const tryAppInChat = useCallback(
    (app: ProviderAppInfo): Promise<boolean> =>
      runExclusive(async () => {
        if (!app.isAccessible || !app.isEnabled) return false;
        const projectId = await ensureProjectId({
          activeProjectId: input.activeProjectId,
          cwd: input.cwd,
          defaultModelSelection,
        });
        if (!projectId) return false;
        const threadId = await handleNewThread(projectId, {
          provider: input.provider,
          ...(input.instanceId ? { providerInstanceId: input.instanceId } : {}),
          fresh: true,
        });
        if (!threadId) return false;
        useComposerDraftStore.getState().setPrompt(threadId, buildAppComposerMention(app));
        return true;
      }),
    [
      runExclusive,
      defaultModelSelection,
      handleNewThread,
      input.activeProjectId,
      input.provider,
      input.instanceId,
      input.cwd,
    ],
  );

  const prepareCanonicalMutation = useCallback(
    async (payload: CanonicalMutationPayload) => {
      if (!input.cwd) return null;
      const plan = await ensureNativeApi().provider.prepareMossResourceMutation({
        ...payload,
        cwd: input.cwd,
      });
      return { cwd: input.cwd, planId: plan.planId, operationId: plan.operationId };
    },
    [input.cwd],
  );

  const uninstall = useCallback(
    async (resource: ResourceDetail): Promise<ResourceDeleteActionResult | null> => {
      if (!input.cwd || !canUninstallResource(resource)) return null;
      const api = ensureNativeApi();
      switch (resource.kind) {
        case "skill":
          return api.provider.deleteMossResource(
            (await prepareCanonicalMutation({
              action: "delete",
              kind: "skill",
              name: resource.skill.name,
            }))!,
          );
        case "mcp":
          return api.provider.deleteMossResource(
            (await prepareCanonicalMutation({
              action: "delete",
              kind: "mcp",
              name: resource.server.name,
            }))!,
          );
        case "plugin":
          const canonicalPath = mossCanonicalPluginManifestPath(resource.plugin);
          if (canonicalPath) {
            return api.provider.deleteMossResource(
              (await prepareCanonicalMutation({
                action: "delete",
                kind: "plugin",
                name: resource.plugin.name,
              }))!,
            );
          }
          await api.provider.uninstallPlugin({
            provider: input.provider,
            ...(input.instanceId ? { instanceId: input.instanceId } : {}),
            cwd: input.cwd,
            pluginId: resource.plugin.id,
          });
          return { removed: true };
      }
    },
    [input.cwd, input.instanceId, input.provider, prepareCanonicalMutation],
  );

  const installPlugin = useCallback(
    async (resource: ResourceDetail): Promise<PluginInstallActionResult | null> => {
      if (resource.kind !== "plugin" || !input.cwd || !canInstallPluginResource(resource)) {
        return null;
      }
      const selector = pluginMarketplaceSelector(resource);
      if (!selector) return null;
      const api = ensureNativeApi();
      const result = await api.provider.installPlugin({
        provider: input.provider,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        cwd: input.cwd,
        ...selector,
        pluginName: resource.plugin.name,
      });
      return normalizePluginInstallActionResult(result);
    },
    [input.cwd, input.instanceId, input.provider],
  );

  const setResourceEnabled = useCallback(
    async (
      resource:
        | { kind: "plugin"; plugin: ProviderPluginDescriptor }
        | { kind: "mcp"; server: ProviderMcpServerDescriptor },
      enabled: boolean,
    ): Promise<ResourceUpdateActionResult | null> => {
      if (!input.cwd) return null;
      const api = ensureNativeApi();
      if (resource.kind === "plugin") {
        if (!canTogglePluginResource(resource.plugin)) return null;
        const canonicalPath = mossCanonicalPluginManifestPath(resource.plugin);
        if (canonicalPath) {
          return api.provider.updateMossResource(
            (await prepareCanonicalMutation({
              action: "update",
              kind: "plugin",
              name: resource.plugin.name,
              enabled,
            }))!,
          );
        }
        const result = await api.provider.setPluginEnabled({
          provider: input.provider,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
          cwd: input.cwd,
          pluginId: resource.plugin.id,
          enabled,
        });
        return { updated: true, overridden: result.status === "okOverridden" };
      }
      if (!canToggleMcpResource(resource.server)) return null;
      return api.provider.updateMossResource(
        (await prepareCanonicalMutation({
          action: "update",
          kind: "mcp",
          name: resource.server.name,
          enabled,
        }))!,
      );
    },
    [input.cwd, input.instanceId, input.provider, prepareCanonicalMutation],
  );

  // Matches Codex "Create skill"/"Create plugin": open a fresh thread and
  // attach the creator skill by reference. Create plugin always seeds its
  // (localized) request, passed as `prompt`; Create skill seeds the built-in
  // request only the first time, then opens with just the creator attached.
  const createViaCreator = useCallback(
    (
      kind: CreatorKind,
      creatorSkill: { name: string; path: string },
      options?: { readonly prompt?: string },
    ): Promise<boolean> =>
      runExclusive(async () => {
        const projectId = await ensureProjectId({
          activeProjectId: input.activeProjectId,
          cwd: input.cwd,
          defaultModelSelection,
        });
        if (!projectId) return false;
        const meta = CREATOR_META[kind];
        const request = options?.prompt?.trim() || null;
        const isFirstOpen = request === null && !readFirstOpenFlag(meta.firstUseKey);
        const threadId = await handleNewThread(projectId, {
          provider: input.provider,
          ...(input.instanceId ? { providerInstanceId: input.instanceId } : {}),
          fresh: true,
        });
        if (!threadId) return false;
        const store = useComposerDraftStore.getState();
        store.setSkills(threadId, [{ name: creatorSkill.name, path: creatorSkill.path }]);
        // Seed the creator skill's own chip token (+ request text) so it renders
        // as a chip and isn't stripped from the turn by the send-time skill filter.
        store.setPrompt(
          threadId,
          buildCreatorPrompt({
            provider: input.provider,
            skillName: creatorSkill.name,
            firstUsePrompt: request ?? (isFirstOpen ? meta.firstUsePrompt : null),
          }),
        );
        if (isFirstOpen) markFirstOpen(meta.firstUseKey);
        return true;
      }),
    [
      runExclusive,
      defaultModelSelection,
      handleNewThread,
      input.activeProjectId,
      input.provider,
      input.instanceId,
      input.cwd,
    ],
  );

  /**
   * Create and immediately dispatch one Creator turn into a task-owned folder.
   * This is intentionally separate from `createViaCreator`: the Plugins page
   * keeps its familiar draft-only behaviour, while tests/automation can opt in
   * to a bounded write flow with an explicit workspace boundary.
   */
  const createViaCreatorAndDispatch = useCallback(
    (
      kind: CreatorKind,
      creatorSkill: { name: string; path: string },
      options: CreatorDispatchOptions,
    ): Promise<CreatorDispatchActionResult | null> => {
      const existing = creatorDispatchFlightRef.current;
      if (existing) return existing;

      const pending = (async (): Promise<CreatorDispatchActionResult | null> => {
        const taskWorkspace = resolveCreatorTaskWorkspace(options.taskWorkspace);
        if (!taskWorkspace) return null;
        const projectId = await ensureProjectId({
          activeProjectId: input.activeProjectId,
          cwd: input.cwd,
          defaultModelSelection,
        });
        if (!projectId) return null;

        const meta = CREATOR_META[kind];
        const threadId = await handleNewThread(projectId, {
          provider: input.provider,
          ...(input.instanceId ? { providerInstanceId: input.instanceId } : {}),
          // Creator writes must stay in the caller-owned scratch/worktree path.
          workingDirectory: taskWorkspace,
          envMode: "local",
          fresh: true,
        });
        if (!threadId) return null;

        const store = useComposerDraftStore.getState();
        store.setSkills(threadId, [{ name: creatorSkill.name, path: creatorSkill.path }]);
        // An explicit dispatch always carries an actionable request. This avoids
        // the second-open chip-only seed becoming an empty turn.
        store.setPrompt(
          threadId,
          buildCreatorPrompt({
            provider: input.provider,
            skillName: creatorSkill.name,
            firstUsePrompt: options.prompt?.trim() || meta.firstUsePrompt,
          }),
        );

        const dispatch = await dispatchDraftThread({
          threadId,
          projectId,
          thread: null,
          defaultProvider: input.provider,
          assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
          providerOptions: getProviderStartOptions(settings, input.instanceId ?? input.provider),
          providerInstances: getProviderInstanceOptions(settings),
        });
        if (dispatch.kind === "dispatched") markFirstOpen(meta.firstUseKey);
        return { threadId, dispatch };
      })();

      creatorDispatchFlightRef.current = pending;
      void pending
        .finally(() => {
          if (creatorDispatchFlightRef.current === pending) {
            creatorDispatchFlightRef.current = null;
          }
        })
        .catch(() => undefined);
      return pending;
    },
    [
      defaultModelSelection,
      handleNewThread,
      input.activeProjectId,
      input.cwd,
      input.instanceId,
      input.provider,
      settings,
    ],
  );

  return {
    tryInChat,
    tryAppInChat,
    uninstall,
    installPlugin,
    setResourceEnabled,
    createViaCreator,
    createViaCreatorAndDispatch,
    resourceName,
  };
}
