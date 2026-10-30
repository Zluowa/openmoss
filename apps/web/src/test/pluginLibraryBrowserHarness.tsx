// FILE: pluginLibraryBrowserHarness.tsx
// Purpose: Mounts the real PluginLibrary route against a deterministic native API for browser tests.
// Layer: Browser integration test support

import { deferred, type Deferred } from "./deferred";
export { deferred, type Deferred } from "./deferred";

import type {
  MossAppToolkit,
  MossCanonicalResourceMutationPrepareInput,
  MossResourceImportApplyInput,
  MossResourceImportApplyResult,
  MossResourceImportInventoryInput,
  MossResourceImportInventoryResult,
  MossResourceImportPlan,
  MossResourceImportPlanInput,
  MossResourceImportPlanResult,
  MossResourceImportRollbackInput,
  MossResourceImportRollbackResult,
  NativeApi,
  ProviderAppInfo,
  ProviderGetComposerCapabilitiesInput,
  ProviderInstallPluginInput,
  ProviderInstallPluginResult,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderPluginDescriptor,
  ProviderPluginMarketplaceLoadError,
  ProviderReadPluginInput,
  ProviderSetPluginEnabledInput,
  ProviderSetPluginEnabledResult,
  ProviderSkillDescriptor,
  ProviderUninstallPluginInput,
  ProviderUninstallPluginResult,
  ServerConfig,
  ServerSettings,
} from "@synara/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { render } from "vitest-browser-react";

import { PluginLibrary } from "~/components/PluginLibrary";
import { SidebarProvider } from "~/components/ui/sidebar";
import { MossLocalizationProvider } from "~/localization";
import { StoreProvider } from "~/store";
import { resetWsNativeApiForTest } from "~/wsNativeApi";

type ImportPlanInput = Parameters<NativeApi["provider"]["resourceImportPlan"]>[0];
type ImportApplyInput = Parameters<NativeApi["provider"]["resourceImportApply"]>[0];
type ImportRollbackInput = Parameters<NativeApi["provider"]["resourceImportRollback"]>[0];

const IMPORT_MISSING_HASH = "0".repeat(64);

export interface BrowserDocumentLocaleSnapshot {
  readonly lang: string;
  readonly mossLocale: string | null;
}

export function snapshotBrowserDocumentLocale(): BrowserDocumentLocaleSnapshot {
  return {
    lang: document.documentElement.lang,
    mossLocale: document.documentElement.getAttribute("data-moss-locale"),
  };
}

export function restoreBrowserDocumentLocale(snapshot: BrowserDocumentLocaleSnapshot): void {
  if (snapshot.lang) document.documentElement.lang = snapshot.lang;
  else document.documentElement.removeAttribute("lang");
  if (snapshot.mossLocale === null) {
    document.documentElement.removeAttribute("data-moss-locale");
  } else {
    document.documentElement.setAttribute("data-moss-locale", snapshot.mossLocale);
  }
}

function importPath(cwd: string, relativePath: string): string {
  return `${cwd.replace(/\/$/u, "")}/${relativePath}`;
}

function importSlug(value: string, kind: "plugin" | "skill" | "mcp"): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 64);
  return slug || `imported-${kind}`;
}

async function importSha256(contents: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(contents),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function importSourceName(input: ImportPlanInput): string {
  const source = input.localSource;
  if (!source) throw new Error("The production import RPC requires a bounded local source.");
  if (source.kind === "plugin") {
    const parsed = JSON.parse(source.contents) as Record<string, unknown>;
    const id = typeof parsed.id === "string" ? parsed.id.split("@")[0] : undefined;
    return typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : id && id.trim()
        ? id.trim()
        : source.sourceName.replace(/\.json$/iu, "");
  }
  if (source.kind === "skill") {
    const match = /^---\s*\n(?:[\s\S]*?\n)?name:\s*(.+?)\s*\n[\s\S]*?---/u.exec(source.contents);
    return match?.[1]?.trim() || source.sourceName.replace(/\.(?:markdown?|md)$/iu, "");
  }
  const parsed = JSON.parse(source.contents) as Record<string, unknown>;
  const servers = parsed.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    const first = Object.keys(servers)[0];
    if (first) return first;
  }
  return source.sourceSelector?.split("::").at(-1) ?? "imported-mcp";
}

export const GITHUB_PLUGIN_ID = "github@openai-curated";
export const SLACK_PLUGIN_ID = "slack@openai-curated";

export function pluginDescriptor(input: {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly installed?: boolean;
  readonly enabled?: boolean;
}): ProviderPluginDescriptor {
  const installed = input.installed ?? false;
  return {
    id: input.id,
    remotePluginId: input.id,
    name: input.name,
    version: "1.0.0",
    localVersion: installed ? "1.0.0" : null,
    shareContext: null,
    availability: "AVAILABLE",
    keywords: [input.name],
    source: { type: "remote" },
    installed,
    enabled: input.enabled ?? installed,
    installPolicy: "AVAILABLE",
    installPolicySource: null,
    authPolicy: "ON_USE",
    interface: {
      displayName: input.displayName,
      shortDescription: `${input.displayName} integration fixture`,
      longDescription: null,
      developerName: "OpenAI",
      category: "Productivity",
      capabilities: [],
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompt: null,
      brandColor: null,
      composerIcon: null,
      composerIconUrl: null,
      logo: null,
      logoDark: null,
      logoUrl: null,
      logoUrlDark: null,
      screenshots: [],
      screenshotUrls: [],
    },
  };
}

const PLUGIN_IDENTITIES = [
  { id: GITHUB_PLUGIN_ID, name: "github", displayName: "GitHub" },
  { id: SLACK_PLUGIN_ID, name: "slack", displayName: "Slack" },
] as const;

function emptyCatalog(): ProviderListPluginsResult {
  return {
    marketplaces: [],
    marketplaceLoadErrors: [],
    remoteSyncError: null,
    featuredPluginIds: [],
    source: "browser-integration-fixture",
    cached: false,
  };
}

function appInfo(id: string, name: string): ProviderAppInfo {
  return {
    id,
    name,
    description: `${name} connector`,
    logoUrl: null,
    logoUrlDark: null,
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: `https://example.test/connect/${id}`,
    isAccessible: false,
    isEnabled: true,
    pluginDisplayNames: ["GitHub"],
  };
}

export type CatalogMode = "loading" | "error" | "empty" | "populated";

export class PluginLibraryNativeFixture {
  catalogMode: CatalogMode;
  readonly installedPluginIds = new Set<string>();
  readonly disabledPluginIds = new Set<string>();
  readonly importFiles = new Map<string, string>();
  readonly importReadFileCalls: Array<Parameters<NativeApi["projects"]["readFile"]>[0]> = [];
  readonly importWriteFileCalls: Array<Parameters<NativeApi["projects"]["writeFile"]>[0]> = [];
  readonly importInventoryCalls: MossResourceImportInventoryInput[] = [];
  readonly importPlanCalls: MossResourceImportPlanInput[] = [];
  readonly importApplyCalls: MossResourceImportApplyInput[] = [];
  readonly importRollbackCalls: MossResourceImportRollbackInput[] = [];
  readonly importDeleteMossResourceCalls: Array<
    Parameters<NativeApi["provider"]["deleteMossResource"]>[0]
  > = [];
  readonly installCalls: ProviderInstallPluginInput[] = [];
  readonly setPluginEnabledCalls: ProviderSetPluginEnabledInput[] = [];
  readonly uninstallPluginCalls: ProviderUninstallPluginInput[] = [];
  readonly listPluginCalls: ProviderListPluginsInput[] = [];
  readonly listAppCalls: Array<Parameters<NativeApi["provider"]["listApps"]>[0]> = [];
  readonly installRequests = new Map<string, Deferred<ProviderInstallPluginResult>>();
  readonly setPluginEnabledRequests = new Map<string, Deferred<ProviderSetPluginEnabledResult>>();
  readonly uninstallPluginRequests = new Map<string, Deferred<ProviderUninstallPluginResult>>();
  readPluginInstalledOverride: boolean | null = null;
  serverSettings: ServerSettings = structuredClone(DEFAULT_SERVER_SETTINGS);
  readonly apps = [appInfo("github", "GitHub"), appInfo("slack", "Slack")];
  readonly skillsCatalog: ProviderSkillDescriptor[] = [];
  readonly discoveredSkills: ProviderSkillDescriptor[] = [];
  readonly additionalPrimaryPlugins: ProviderPluginDescriptor[] = [];
  readonly workspacePlugins: ProviderPluginDescriptor[] = [];
  readonly loadingCatalog = deferred<ProviderListPluginsResult>();
  catalogError: Error = new Error("Plugin catalog unavailable");
  optionalShardError: Error | null = null;
  /** Load errors every optional lane reports, as the server sends them. */
  optionalShardLoadErrors: ProviderPluginMarketplaceLoadError[] = [];
  /** The server's Moss Apps catalog; null leaves the app backend unconfigured. */
  mossAppToolkits: MossAppToolkit[] | null = null;
  /** How many Moss Apps catalog reads fail before one succeeds. */
  mossAppCatalogFailures = 0;
  appListError: Error | null = null;
  private importSequence = 0;
  private canonicalMutationSequence = 0;
  private readonly importPlans = new Map<
    string,
    {
      readonly plan: MossResourceImportPlan;
      readonly targetKey: string;
      readonly beforeContents: string | undefined;
      readonly afterContents: string;
      readonly beforeHash: string;
      readonly afterHash: string;
      readonly action: "copy" | "merge" | "replace";
    }
  >();
  private readonly importTransactions = new Map<
    string,
    {
      readonly plan: MossResourceImportPlan;
      readonly targetKey: string;
      readonly beforeContents: string | undefined;
      readonly afterHash: string;
    }
  >();

  constructor(mode: CatalogMode = "populated") {
    this.catalogMode = mode;
  }

  private currentPlugins(): ProviderPluginDescriptor[] {
    return [
      ...PLUGIN_IDENTITIES.map((plugin) =>
        pluginDescriptor({
          ...plugin,
          installed: this.installedPluginIds.has(plugin.id),
          enabled: this.installedPluginIds.has(plugin.id) && !this.disabledPluginIds.has(plugin.id),
        }),
      ),
      ...this.additionalPrimaryPlugins,
    ];
  }

  catalog(): ProviderListPluginsResult {
    if (this.catalogMode === "empty") return emptyCatalog();
    return {
      marketplaces: [
        {
          name: "openai-curated",
          path: null,
          interface: null,
          plugins: this.currentPlugins(),
        },
      ],
      marketplaceLoadErrors: [],
      remoteSyncError: null,
      featuredPluginIds: [GITHUB_PLUGIN_ID],
      source: "browser-integration-fixture",
      cached: false,
    };
  }

  private listPlugins = async (
    input: ProviderListPluginsInput,
  ): Promise<ProviderListPluginsResult> => {
    this.listPluginCalls.push(input);
    // No kinds is Codex's default catalog (the primary lane); naming local or
    // vertical narrows it but is still the primary catalog.
    const primary =
      input.marketplaceKinds === undefined ||
      input.marketplaceKinds.includes("local") ||
      input.marketplaceKinds.includes("vertical");
    if (!primary) {
      if (this.optionalShardError) throw this.optionalShardError;
      if (input.marketplaceKinds?.includes("workspace-directory")) {
        return {
          ...emptyCatalog(),
          marketplaceLoadErrors: this.optionalShardLoadErrors,
          marketplaces: [
            {
              name: "workspace-directory",
              path: null,
              interface: null,
              plugins: this.workspacePlugins,
            },
          ],
        };
      }
      return { ...emptyCatalog(), marketplaceLoadErrors: this.optionalShardLoadErrors };
    }
    if (this.catalogMode === "loading") return this.loadingCatalog.promise;
    if (this.catalogMode === "error") throw this.catalogError;
    return this.catalog();
  };

  private installPlugin = async (
    input: ProviderInstallPluginInput,
  ): Promise<ProviderInstallPluginResult> => {
    this.installCalls.push(input);
    const request = deferred<ProviderInstallPluginResult>();
    this.installRequests.set(input.pluginName, request);
    return request.promise;
  };

  completeInstall(
    pluginName: string,
    result: ProviderInstallPluginResult = { authPolicy: "ON_USE", appsNeedingAuth: [] },
  ): void {
    const identity = PLUGIN_IDENTITIES.find((plugin) => plugin.name === pluginName);
    const request = this.installRequests.get(pluginName);
    if (!identity || !request) throw new Error(`No pending install for ${pluginName}.`);
    this.installedPluginIds.add(identity.id);
    this.disabledPluginIds.delete(identity.id);
    request.resolve(result);
  }

  failInstallAfterPersistence(pluginName: string, error: Error): void {
    const identity = PLUGIN_IDENTITIES.find((plugin) => plugin.name === pluginName);
    const request = this.installRequests.get(pluginName);
    if (!identity || !request) throw new Error(`No pending install for ${pluginName}.`);
    this.installedPluginIds.add(identity.id);
    this.disabledPluginIds.delete(identity.id);
    request.reject(error);
  }

  private nextImportId(prefix: string): string {
    this.importSequence += 1;
    return `${prefix}-${this.importSequence}`;
  }

  private async planResourceImport(input: ImportPlanInput): Promise<MossResourceImportPlanResult> {
    this.importPlanCalls.push(input);
    const source = input.localSource;
    if (!source) throw new Error("The production import RPC requires a bounded local source.");
    const name = importSourceName(input);
    const slug = importSlug(name, source.kind);
    const relativeTarget =
      source.kind === "mcp"
        ? ".moss/mcp/config.json"
        : source.kind === "plugin"
          ? `.moss/plugins/${slug}/plugin.json`
          : `.moss/skills/${slug}/SKILL.md`;
    const targetKey = `${input.cwd}:${relativeTarget}`;
    const beforeContents = this.importFiles.get(targetKey);
    const sourceHash = await importSha256(source.contents);
    const beforeHash =
      beforeContents === undefined ? IMPORT_MISSING_HASH : await importSha256(beforeContents);
    let afterContents = source.contents;
    let action: "copy" | "merge" | "replace" = "copy";
    if (source.kind === "mcp" && beforeContents !== undefined) {
      const existing = JSON.parse(beforeContents) as Record<string, unknown>;
      const incoming = JSON.parse(source.contents) as Record<string, unknown>;
      const existingServers =
        existing.mcpServers &&
        typeof existing.mcpServers === "object" &&
        !Array.isArray(existing.mcpServers)
          ? (existing.mcpServers as Record<string, unknown>)
          : {};
      const incomingServers =
        incoming.mcpServers &&
        typeof incoming.mcpServers === "object" &&
        !Array.isArray(incoming.mcpServers)
          ? (incoming.mcpServers as Record<string, unknown>)
          : {};
      afterContents = `${JSON.stringify(
        { ...existing, mcpServers: { ...existingServers, ...incomingServers } },
        null,
        2,
      )}\n`;
      action = "merge";
    } else if (beforeContents !== undefined) {
      if (!source.replaceExisting) {
        action = "replace";
      } else {
        action = "replace";
      }
    }
    const afterHash = await importSha256(afterContents);
    const operationId = this.nextImportId("operation");
    const planId = this.nextImportId("plan");
    const now = new Date().toISOString();
    const operation = {
      operationId,
      resourceId: `local-${source.kind}-${slug}`,
      kind: source.kind,
      provider: "codex" as const,
      scope: "workspace" as const,
      name,
      sourcePath: `/private/moss-import/${source.sourceName}`,
      ...(source.sourceSelector ? { sourceSelector: source.sourceSelector } : {}),
      sourceSha256: sourceHash,
      snapshotPath: `/private/moss-snapshots/${source.sourceName}`,
      snapshotSha256: sourceHash,
      targetPath: importPath(input.cwd, relativeTarget),
      action,
      ...(beforeContents !== undefined ? { expectedBeforeHash: beforeHash } : {}),
      secretFields: [],
      warnings: [],
      canonicalIdentityKey: `${source.kind}:${slug}`,
      enabled: true,
      quarantined: false,
    };
    const unsignedPlan = {
      schemaVersion: 1 as const,
      planId,
      cwd: input.cwd,
      createdAt: now,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      issuer: "browser-fixture-server",
      ownerId: "browser-fixture-owner",
      projectId: "browser-fixture-project",
      principalId: "browser-fixture-principal",
      sessionId: "browser-fixture-session",
      workspaceId: "browser-fixture-workspace",
      stateFingerprint: await importSha256(input.cwd),
      stateRoot: `${input.cwd}/.moss`,
      nonce: this.nextImportId("nonce"),
      selectedResourceIds: [operation.resourceId],
      operations: [operation],
      issues: [],
      ...(input.selectionOrigin ? { selectionOrigin: input.selectionOrigin } : {}),
      selectionSnapshotSha256: sourceHash,
    };
    const planHash = await importSha256(JSON.stringify(unsignedPlan));
    const plan = { ...unsignedPlan, planHash } satisfies MossResourceImportPlan;
    this.importPlans.set(plan.planId, {
      plan,
      targetKey,
      beforeContents,
      afterContents,
      beforeHash,
      afterHash,
      action,
    });
    return { plan };
  }

  private async applyResourceImport(
    input: ImportApplyInput,
  ): Promise<MossResourceImportApplyResult> {
    this.importApplyCalls.push(input);
    const prepared = this.importPlans.get(input.plan.planId);
    if (!prepared || prepared.plan.planHash !== input.plan.planHash) {
      return {
        transactionId: `transaction-${input.plan.planId}`,
        planId: input.plan.planId,
        status: "blocked",
        operations: [],
        issues: [],
      };
    }
    const current = this.importFiles.get(prepared.targetKey);
    const currentHash = current === undefined ? IMPORT_MISSING_HASH : await importSha256(current);
    if (currentHash !== prepared.beforeHash) {
      return {
        transactionId: `transaction-${prepared.plan.planId}`,
        planId: prepared.plan.planId,
        status: "blocked",
        operations: [
          {
            operationId: prepared.plan.operations[0]!.operationId,
            status: "conflict",
            targetPath: prepared.plan.operations[0]!.targetPath,
            message: "The target changed after planning.",
          },
        ],
        issues: [],
      };
    }
    this.importFiles.set(prepared.targetKey, prepared.afterContents);
    const operation = prepared.plan.operations[0]!;
    const transactionId = `transaction-${prepared.plan.planId}`;
    this.importTransactions.set(transactionId, {
      plan: prepared.plan,
      targetKey: prepared.targetKey,
      beforeContents: prepared.beforeContents,
      afterHash: prepared.afterHash,
    });
    return {
      transactionId,
      planId: prepared.plan.planId,
      status: "committed",
      operations: [
        {
          operationId: operation.operationId,
          status: prepared.action === "merge" ? "merged" : "created",
          targetPath: operation.targetPath,
        },
      ],
      issues: [],
      receipt: {
        transactionId,
        operationId: operation.operationId,
        planHash: prepared.plan.planHash,
        afterState: [
          {
            operationId: operation.operationId,
            targetPath: operation.targetPath,
            state: "present",
            afterHash: prepared.afterHash,
            durable: true,
          },
        ],
      },
    };
  }

  private async rollbackResourceImport(
    input: ImportRollbackInput,
  ): Promise<MossResourceImportRollbackResult> {
    this.importRollbackCalls.push(input);
    const transaction = this.importTransactions.get(input.transactionId);
    if (!transaction) {
      return { transactionId: input.transactionId, status: "not-found", restored: [], issues: [] };
    }
    const current = this.importFiles.get(transaction.targetKey);
    const currentHash = current === undefined ? IMPORT_MISSING_HASH : await importSha256(current);
    const operation = transaction.plan.operations[0]!;
    if (currentHash !== transaction.afterHash) {
      return {
        transactionId: input.transactionId,
        status: "partial",
        restored: [
          {
            operationId: operation.operationId,
            status: "conflict",
            targetPath: operation.targetPath,
          },
        ],
        issues: [],
      };
    }
    if (transaction.beforeContents === undefined) this.importFiles.delete(transaction.targetKey);
    else this.importFiles.set(transaction.targetKey, transaction.beforeContents);
    return {
      transactionId: input.transactionId,
      status: "rolled-back",
      restored: [
        { operationId: operation.operationId, status: "skipped", targetPath: operation.targetPath },
      ],
      issues: [],
    };
  }

  completeSetPluginEnabled(pluginId: string, enabled: boolean): void {
    const request = this.setPluginEnabledRequests.get(pluginId);
    if (!request) throw new Error(`No pending enabled-state update for ${pluginId}.`);
    if (enabled) this.disabledPluginIds.delete(pluginId);
    else this.disabledPluginIds.add(pluginId);
    request.resolve({ status: "ok" });
  }

  completeUninstall(pluginId: string): void {
    const request = this.uninstallPluginRequests.get(pluginId);
    if (!request) throw new Error(`No pending uninstall for ${pluginId}.`);
    this.installedPluginIds.delete(pluginId);
    this.disabledPluginIds.delete(pluginId);
    request.resolve({});
  }

  nativeApi(): NativeApi {
    const serverConfig: ServerConfig = {
      cwd: "/repo/project",
      worktreesDir: "/repo/.worktrees",
      keybindingsConfigPath: "/repo/project/.moss-keybindings.json",
      keybindings: [],
      issues: [],
      providers: [],
      availableEditors: [],
    };
    return {
      server: {
        getConfig: async () => serverConfig,
        getSettings: async () => this.serverSettings,
        updateSettings: async (input: Parameters<NativeApi["server"]["updateSettings"]>[0]) => {
          if (input.skills?.disabled) {
            this.serverSettings = {
              ...this.serverSettings,
              skills: { ...this.serverSettings.skills, disabled: [...input.skills.disabled] },
            };
          }
          return this.serverSettings;
        },
        getMossAppsStatus: async () => ({
          availability: this.mossAppToolkits ? ("ready" as const) : ("unconfigured" as const),
          agentAccess: false,
        }),
        listMossAppToolkits: async () => {
          if (this.mossAppCatalogFailures > 0) {
            this.mossAppCatalogFailures -= 1;
            throw new Error("Moss could not load apps.");
          }
          const toolkits = this.mossAppToolkits ?? [];
          return { toolkits, nextCursor: null, totalItems: toolkits.length };
        },
        listMossAppConnections: async () => ({ connections: [] }),
      },
      projects: {
        readFile: async (input: Parameters<NativeApi["projects"]["readFile"]>[0]) => {
          this.importReadFileCalls.push(input);
          const contents = this.importFiles.get(`${input.cwd}:${input.relativePath}`);
          if (contents === undefined) {
            throw new Error("ENOENT: destination missing");
          }
          return { relativePath: input.relativePath, contents, truncated: false };
        },
        writeFile: async (input: Parameters<NativeApi["projects"]["writeFile"]>[0]) => {
          this.importWriteFileCalls.push(input);
          this.importFiles.set(`${input.cwd}:${input.relativePath}`, input.contents);
          return { relativePath: input.relativePath };
        },
      },
      provider: {
        getComposerCapabilities: async ({ provider }: ProviderGetComposerCapabilitiesInput) => ({
          provider,
          supportsSkillMentions: provider === "codex",
          supportsSkillDiscovery: provider === "codex",
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: provider === "codex",
          supportsPluginDiscovery: provider === "codex",
          supportsRuntimeModelList: false,
          supportsThreadCompaction: false,
          supportsThreadImport: false,
        }),
        listPlugins: this.listPlugins,
        listMcp: async () => ({
          servers: [],
          source: "browser-integration-fixture",
          cached: false,
        }),
        resourceImportInventory: async (
          input: MossResourceImportInventoryInput,
        ): Promise<MossResourceImportInventoryResult> => {
          this.importInventoryCalls.push(input);
          return {
            inventoryId: "inventory-browser-fixture",
            cwd: input.cwd,
            generatedAt: new Date().toISOString(),
            roots: [],
            resources: [],
            issues: [],
          };
        },
        resourceImportPlan: this.planResourceImport.bind(this),
        resourceImportApply: this.applyResourceImport.bind(this),
        resourceImportRollback: this.rollbackResourceImport.bind(this),
        prepareMossResourceMutation: async (input: MossCanonicalResourceMutationPrepareInput) => {
          const sequence = ++this.canonicalMutationSequence;
          return {
            planId: `plan-browser-${sequence}`,
            operationId: `operation-browser-${sequence}`,
            planHash: "0".repeat(64),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
        listSkills: async (input: Parameters<NativeApi["provider"]["listSkills"]>[0]) => ({
          skills: input.includeDisabled
            ? this.discoveredSkills
            : this.discoveredSkills.filter(
                (skill) => !this.serverSettings.skills.disabled.includes(skill.name.toLowerCase()),
              ),
          source: "browser-integration-fixture",
          cached: false,
        }),
        listSkillsCatalog: async () => ({
          skills: this.skillsCatalog,
          mossSkillsDir: "/repo/project/.moss/skills",
        }),
        listModels: async () => ({
          models: [],
          source: "browser-integration-fixture",
          cached: false,
        }),
        listAgents: async () => ({
          agents: [],
          source: "browser-integration-fixture",
          cached: false,
        }),
        deleteMossResource: async (
          input: Parameters<NativeApi["provider"]["deleteMossResource"]>[0],
        ) => {
          this.importDeleteMossResourceCalls.push(input);
          return { kind: "plugin", name: "fixture", removed: true };
        },
        createMossResource: async () => ({
          kind: "plugin",
          name: "fixture",
          path: "/repo/project/.moss/plugins/fixture/plugin.json",
          created: true,
        }),
        updateMossResource: async () => ({
          kind: "plugin",
          name: "fixture",
          enabled: true,
          updated: true,
        }),
        listApps: async (input: Parameters<NativeApi["provider"]["listApps"]>[0]) => {
          this.listAppCalls.push(input);
          if (this.appListError) throw this.appListError;
          return { data: this.apps, nextCursor: null };
        },
        installPlugin: this.installPlugin,
        readPlugin: async ({ pluginName }: ProviderReadPluginInput) => {
          const summary = this.currentPlugins().find((plugin) => plugin.name === pluginName);
          if (!summary) throw new Error(`Unknown plugin ${pluginName}.`);
          const detailSummary =
            this.readPluginInstalledOverride === null
              ? summary
              : { ...summary, installed: this.readPluginInstalledOverride };
          return {
            plugin: {
              marketplaceName: "openai-curated",
              marketplacePath: null,
              summary: detailSummary,
              shareUrl: null,
              description: detailSummary.interface?.shortDescription ?? null,
              apps: [],
              skills: [],
              hooks: [],
              appTemplates: [],
              mcpServers: [],
            },
          };
        },
        setPluginEnabled: async (input: ProviderSetPluginEnabledInput) => {
          this.setPluginEnabledCalls.push(input);
          const request = deferred<ProviderSetPluginEnabledResult>();
          this.setPluginEnabledRequests.set(input.pluginId, request);
          return request.promise;
        },
        uninstallPlugin: async (input: ProviderUninstallPluginInput) => {
          this.uninstallPluginCalls.push(input);
          const request = deferred<ProviderUninstallPluginResult>();
          this.uninstallPluginRequests.set(input.pluginId, request);
          return request.promise;
        },
      },
      shell: {
        openExternal: async () => undefined,
      },
      dialogs: {
        confirm: async () => true,
      },
    } as unknown as NativeApi;
  }
}

function TestProviders({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient: QueryClient;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <StoreProvider>
        <MossLocalizationProvider>
          <SidebarProvider defaultOpen={false}>{children}</SidebarProvider>
        </MossLocalizationProvider>
      </StoreProvider>
    </QueryClientProvider>
  );
}

export async function mountPluginLibrary(input: {
  readonly fixture: PluginLibraryNativeFixture;
  readonly initialEntries?: readonly string[];
}) {
  const previousNativeApi = window.nativeApi;
  const previousAppSettings = localStorage.getItem("moss:app-settings:v1");
  const previousDocumentLocale = snapshotBrowserDocumentLocale();
  localStorage.setItem("moss:app-settings:v1", JSON.stringify({ localeOverride: "en" }));
  window.nativeApi = input.fixture.nativeApi();

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const routeComponent = () => <PluginLibrary />;
  const skillsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills",
    component: routeComponent,
  });
  const manageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills/manage",
    component: routeComponent,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills/plugins/$pluginId",
    component: routeComponent,
  });
  const manageDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills/manage/plugins/$pluginId",
    component: routeComponent,
  });
  const settingsPluginsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/plugins-settings",
    component: routeComponent,
  });
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  let cancelMountedRouter: (() => void) | undefined;
  let unmountScreen: (() => Promise<void>) | undefined;
  try {
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        skillsRoute,
        manageRoute,
        detailRoute,
        manageDetailRoute,
        settingsPluginsRoute,
      ]),
      history: createMemoryHistory({ initialEntries: [...(input.initialEntries ?? ["/skills"])] }),
      defaultPreload: false,
      Wrap: ({ children }) => <TestProviders queryClient={queryClient}>{children}</TestProviders>,
    });
    cancelMountedRouter = () => router.cancelMatches();
    await router.load();
    document.body.append(host);
    const screen = await render(<RouterProvider router={router} />, { container: host });
    unmountScreen = screen.unmount;

    return {
      fixture: input.fixture,
      host,
      queryClient,
      router,
      async cleanup() {
        await screen.unmount();
        router.cancelMatches();
        await resetWsNativeApiForTest();
        queryClient.clear();
        host.remove();
        if (previousNativeApi) window.nativeApi = previousNativeApi;
        else delete window.nativeApi;
        if (previousAppSettings === null) localStorage.removeItem("moss:app-settings:v1");
        else localStorage.setItem("moss:app-settings:v1", previousAppSettings);
        restoreBrowserDocumentLocale(previousDocumentLocale);
        document.body.innerHTML = "";
      },
    };
  } catch (error) {
    await unmountScreen?.();
    cancelMountedRouter?.();
    await resetWsNativeApiForTest();
    queryClient.clear();
    host.remove();
    if (previousNativeApi) window.nativeApi = previousNativeApi;
    else delete window.nativeApi;
    if (previousAppSettings === null) localStorage.removeItem("moss:app-settings:v1");
    else localStorage.setItem("moss:app-settings:v1", previousAppSettings);
    restoreBrowserDocumentLocale(previousDocumentLocale);
    document.body.innerHTML = "";
    throw error;
  }
}
