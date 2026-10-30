import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ProviderComposerCapabilities,
  ProviderKind,
  ProviderListModelsResult,
  ProviderListPluginsResult,
  ProviderListSkillsResult,
  SupportedProviderKind,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

const DEFAULT_EVIDENCE_DIR = ".moss/ledger/evidence";
const PROVIDER: SupportedProviderKind = "codex";
const RUNTIME_BOUNDARY = "ProviderDiscoveryServiceLive";

const REQUIRED_OPERATION_IDS = [
  "getComposerCapabilities",
  "listSkills",
  "listPlugins",
  "listModels",
] as const;

const REQUIRED_SKILL_NAMES = ["moss-native-smoke-skill", "moss-portable-smoke-skill"] as const;
const REQUIRED_PLUGIN_NAMES = ["moss-provider-smoke-plugin"] as const;
const REQUIRED_MODEL_SLUGS = ["moss-smoke-model"] as const;

export type MossProviderDiscoverySmokeOperationId = (typeof REQUIRED_OPERATION_IDS)[number];

export interface MossProviderDiscoverySmokeOperation {
  readonly id: MossProviderDiscoverySmokeOperationId;
  readonly status: "pass" | "fail";
  readonly source?: string | undefined;
  readonly count?: number | undefined;
  readonly items?: ReadonlyArray<string> | undefined;
  readonly supportsSkillDiscovery?: boolean | undefined;
  readonly supportsPluginDiscovery?: boolean | undefined;
  readonly supportsRuntimeModelList?: boolean | undefined;
  readonly errorMessage?: string | undefined;
}

export interface MossProviderDiscoverySmokeReport {
  readonly version: 1;
  readonly createdAt: string;
  readonly provider: ProviderKind;
  readonly cwd: string;
  readonly runtimeBoundary: typeof RUNTIME_BOUNDARY;
  readonly providerCredentialsRequired: false;
  readonly writesGlobalConfig: false;
  readonly requiredOperations: ReadonlyArray<MossProviderDiscoverySmokeOperationId>;
  readonly adapterInvocationOrder: ReadonlyArray<string>;
  readonly operations: ReadonlyArray<MossProviderDiscoverySmokeOperation>;
  readonly expectations: {
    readonly skillNames: ReadonlyArray<string>;
    readonly pluginNames: ReadonlyArray<string>;
    readonly modelSlugs: ReadonlyArray<string>;
  };
  readonly readiness: {
    readonly status: "pass" | "fail";
    readonly summary: string;
  };
}

interface SmokeRuntimePaths {
  readonly root: string;
  readonly homeDir: string;
  readonly baseDir: string;
  readonly cwd: string;
}

export interface MossProviderDiscoverySmokeOptions {
  readonly createdAt?: string | undefined;
  readonly cwd?: string | undefined;
}

type LayerEffectTag = Parameters<typeof Layer.effect>[0];
type LayerSucceedTag = Parameters<typeof Layer.succeed>[0];
type EffectServiceTag = Parameters<typeof Effect.service>[0];
type RuntimeLayer = Layer.Layer<never, unknown, never>;

type SmokeServerDerivedPaths = Record<string, string>;

interface ProviderDiscoveryRuntime {
  readonly resolveDefaultChatWorkspaceRoot: (input: { readonly homeDir: string }) => string;
  readonly ServerConfig: LayerEffectTag;
  readonly ServerSettingsService: {
    readonly layerTest: () => RuntimeLayer;
  };
  readonly ProviderAdapterRegistry: LayerSucceedTag;
  readonly ProviderDiscoveryService: EffectServiceTag;
  readonly ProviderDiscoveryServiceLive: RuntimeLayer;
  readonly ProviderHealth: EffectServiceTag;
  readonly clearSkillsCatalogCacheForTests: () => void;
}

interface SmokeProviderListInput {
  readonly provider: ProviderKind;
  readonly cwd?: string | undefined;
  readonly forceReload?: boolean | undefined;
}

interface SmokeProviderDiscoveryService {
  readonly getComposerCapabilities: (input: {
    readonly provider: ProviderKind;
  }) => Effect.Effect<ProviderComposerCapabilities, unknown, unknown>;
  readonly listSkills: (
    input: SmokeProviderListInput,
  ) => Effect.Effect<ProviderListSkillsResult, unknown, unknown>;
  readonly listPlugins: (
    input: SmokeProviderListInput,
  ) => Effect.Effect<ProviderListPluginsResult, unknown, unknown>;
  readonly listModels: (
    input: SmokeProviderListInput,
  ) => Effect.Effect<ProviderListModelsResult, unknown, unknown>;
}

interface SmokeProviderAdapterShape {
  readonly getComposerCapabilities?: () => Effect.Effect<
    ProviderComposerCapabilities,
    unknown,
    unknown
  >;
  readonly listSkills?: (
    input: SmokeProviderListInput,
  ) => Effect.Effect<ProviderListSkillsResult, unknown, unknown>;
  readonly listPlugins?: (
    input: SmokeProviderListInput,
  ) => Effect.Effect<ProviderListPluginsResult, unknown, unknown>;
  readonly listModels?: (
    input: SmokeProviderListInput,
  ) => Effect.Effect<ProviderListModelsResult, unknown, unknown>;
}

function serverRuntimeModuleUrl(path: string): string {
  return new URL(`../apps/server/src/${path}`, import.meta.url).href;
}

async function importServerRuntimeModule(path: string): Promise<Record<string, unknown>> {
  return import(serverRuntimeModuleUrl(path)) as Promise<Record<string, unknown>>;
}

function requireRuntimeExport<T>(
  moduleName: string,
  exports: Record<string, unknown>,
  exportName: string,
): T {
  const value = exports[exportName];
  if (value === undefined || value === null) {
    throw new Error(`Missing server runtime export ${moduleName}.${exportName}`);
  }
  return value as T;
}

async function loadProviderDiscoveryRuntime(): Promise<ProviderDiscoveryRuntime> {
  const [
    configModule,
    serverSettingsModule,
    adapterRegistryModule,
    discoveryServiceModule,
    discoveryLayerModule,
    providerHealthModule,
    skillsCatalogModule,
  ] = await Promise.all([
    importServerRuntimeModule("config.ts"),
    importServerRuntimeModule("serverSettings.ts"),
    importServerRuntimeModule("provider/Services/ProviderAdapterRegistry.ts"),
    importServerRuntimeModule("provider/Services/ProviderDiscoveryService.ts"),
    importServerRuntimeModule("provider/Layers/ProviderDiscoveryService.ts"),
    importServerRuntimeModule("provider/Services/ProviderHealth.ts"),
    importServerRuntimeModule("provider/skillsCatalog.ts"),
  ]);

  return {
    resolveDefaultChatWorkspaceRoot: requireRuntimeExport(
      "config",
      configModule,
      "resolveDefaultChatWorkspaceRoot",
    ) as ProviderDiscoveryRuntime["resolveDefaultChatWorkspaceRoot"],
    ServerConfig: requireRuntimeExport("config", configModule, "ServerConfig"),
    ServerSettingsService: requireRuntimeExport(
      "serverSettings",
      serverSettingsModule,
      "ServerSettingsService",
    ) as ProviderDiscoveryRuntime["ServerSettingsService"],
    ProviderAdapterRegistry: requireRuntimeExport(
      "ProviderAdapterRegistry",
      adapterRegistryModule,
      "ProviderAdapterRegistry",
    ),
    ProviderDiscoveryService: requireRuntimeExport(
      "ProviderDiscoveryService",
      discoveryServiceModule,
      "ProviderDiscoveryService",
    ),
    ProviderDiscoveryServiceLive: requireRuntimeExport(
      "ProviderDiscoveryServiceLive",
      discoveryLayerModule,
      "ProviderDiscoveryServiceLive",
    ) as ProviderDiscoveryRuntime["ProviderDiscoveryServiceLive"],
    ProviderHealth: requireRuntimeExport(
      "ProviderHealth",
      providerHealthModule,
      "ProviderHealth",
    ) as ProviderDiscoveryRuntime["ProviderHealth"],
    clearSkillsCatalogCacheForTests: requireRuntimeExport(
      "skillsCatalog",
      skillsCatalogModule,
      "clearSkillsCatalogCacheForTests",
    ) as ProviderDiscoveryRuntime["clearSkillsCatalogCacheForTests"],
  };
}

function artifactDate(createdAt: string): string {
  return createdAt.slice(0, 10);
}

function defaultReportPath(createdAt: string): string {
  return `${DEFAULT_EVIDENCE_DIR}/moss-provider-discovery-smoke-${artifactDate(createdAt)}.json`;
}

function writeSkill(skillDir: string, name: string): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} smoke skill\n---\n\n# ${name}\n`,
    "utf8",
  );
}

function makeRuntimePaths(cwd: string): SmokeRuntimePaths {
  const root = mkdtempSync(join(tmpdir(), "moss-provider-discovery-smoke-"));
  const homeDir = join(root, "home");
  const baseDir = join(homeDir, ".moss");
  return {
    root,
    homeDir,
    baseDir,
    cwd,
  };
}

function seedSmokeRuntime(paths: SmokeRuntimePaths): void {
  writeSkill(
    join(paths.baseDir, "skills", "moss-portable-smoke-skill"),
    "moss-portable-smoke-skill",
  );
  writeSkill(
    join(paths.homeDir, ".codex", "skills", "moss-native-smoke-skill"),
    "moss-native-smoke-skill",
  );
  mkdirSync(join(paths.homeDir, ".codex", "plugins", "moss-provider-smoke-plugin"), {
    recursive: true,
  });
}

function deriveSmokeServerPaths(baseDir: string): SmokeServerDerivedPaths {
  const stateDir = join(baseDir, "userdata");
  const secretsDir = join(stateDir, "secrets");
  const attachmentsDir = join(stateDir, "attachments");
  const logsDir = join(stateDir, "logs");
  const providerLogsDir = join(logsDir, "provider");
  return {
    stateDir,
    secretsDir,
    dbPath: join(stateDir, "state.sqlite"),
    settingsPath: join(stateDir, "settings.json"),
    keybindingsConfigPath: join(stateDir, "keybindings.json"),
    worktreesDir: join(baseDir, "worktrees"),
    attachmentsDir,
    logsDir,
    serverLogPath: join(logsDir, "server.log"),
    serverRuntimeStatePath: join(stateDir, "server-runtime.json"),
    providerLogsDir,
    providerEventLogPath: join(providerLogsDir, "events.log"),
    terminalLogsDir: join(logsDir, "terminals"),
    anonymousIdPath: join(stateDir, "anonymous-id"),
    environmentIdPath: join(stateDir, "environment-id"),
  };
}

function makeConfigLayer(
  runtime: ProviderDiscoveryRuntime,
  paths: SmokeRuntimePaths,
): RuntimeLayer {
  return Layer.effect(
    runtime.ServerConfig,
    Effect.succeed({
      mode: "web",
      port: 0,
      host: undefined,
      cwd: paths.cwd,
      homeDir: paths.homeDir,
      chatWorkspaceRoot: runtime.resolveDefaultChatWorkspaceRoot({ homeDir: paths.homeDir }),
      baseDir: paths.baseDir,
      ...deriveSmokeServerPaths(paths.baseDir),
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      authToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logProviderEvents: false,
      logWebSocketEvents: false,
    }),
  ) as unknown as RuntimeLayer;
}

function makeRegistryLayer(
  runtime: ProviderDiscoveryRuntime,
  invocations: string[],
  paths: SmokeRuntimePaths,
): RuntimeLayer {
  const adapter: SmokeProviderAdapterShape = {
    getComposerCapabilities: () => {
      invocations.push("getComposerCapabilities");
      return Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);
    },
    listSkills: (input) => {
      invocations.push(`listSkills:${input.provider}`);
      return Effect.succeed({
        skills: [
          {
            name: "moss-native-smoke-skill",
            description: "Native smoke skill from the provider adapter.",
            path: join(paths.homeDir, ".codex", "skills", "moss-native-smoke-skill", "SKILL.md"),
            enabled: true,
            scope: "codex",
          },
        ],
        source: "codex-smoke-adapter",
        cached: false,
      } satisfies ProviderListSkillsResult);
    },
    listPlugins: (input) => {
      invocations.push(`listPlugins:${input.provider}`);
      return Effect.succeed({
        marketplaces: [
          {
            name: "moss-smoke-marketplace",
            path: join(input.cwd ?? process.cwd(), ".moss", "smoke-marketplace.json"),
            interface: {
              displayName: "Moss Smoke Marketplace",
            },
            plugins: [
              {
                id: "moss-provider-smoke-plugin",
                remotePluginId: null,
                name: "moss-provider-smoke-plugin",
                version: null,
                localVersion: null,
                shareContext: null,
                availability: "AVAILABLE",
                keywords: [],
                source: {
                  type: "local",
                  path: join(paths.homeDir, ".codex", "plugins", "moss-provider-smoke-plugin"),
                },
                installed: true,
                enabled: true,
                installPolicy: "INSTALLED_BY_DEFAULT",
                installPolicySource: null,
                authPolicy: "ON_USE",
                interface: {
                  displayName: "Moss Provider Smoke Plugin",
                  shortDescription: "Provider discovery smoke plugin",
                  longDescription: null,
                  developerName: "Moss",
                  category: "Developer Tools",
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
              },
            ],
          },
        ],
        marketplaceLoadErrors: [],
        remoteSyncError: null,
        featuredPluginIds: ["moss-provider-smoke-plugin"],
        source: "codex-smoke-adapter",
        cached: false,
      } satisfies ProviderListPluginsResult);
    },
    listModels: (input) => {
      invocations.push(`listModels:${input.provider}`);
      return Effect.succeed({
        models: [
          {
            slug: "moss-smoke-model",
            name: "Moss Smoke Model",
            supportsFastMode: true,
            supportedReasoningEfforts: [{ value: "medium" }],
            defaultReasoningEffort: "medium",
          },
        ],
        source: "codex-smoke-adapter",
        cached: false,
      } satisfies ProviderListModelsResult);
    },
  };

  return Layer.succeed(runtime.ProviderAdapterRegistry, {
    getByProvider: (provider: ProviderKind) => {
      invocations.push(`getByProvider:${provider}`);
      return Effect.succeed(adapter);
    },
    listProviders: () => Effect.succeed([PROVIDER]),
  }) as unknown as RuntimeLayer;
}

function operationPass(
  operation: Omit<MossProviderDiscoverySmokeOperation, "status">,
): MossProviderDiscoverySmokeOperation {
  return {
    ...operation,
    status: "pass",
  };
}

function operationFail(
  id: MossProviderDiscoverySmokeOperationId,
  error: unknown,
): MossProviderDiscoverySmokeOperation {
  return {
    id,
    status: "fail",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

async function runProviderDiscoveryOperations(input: {
  readonly paths: SmokeRuntimePaths;
  readonly invocations: string[];
  readonly runtime: ProviderDiscoveryRuntime;
}): Promise<ReadonlyArray<MossProviderDiscoverySmokeOperation>> {
  // The discovery layer reads ProviderHealth only for Claude runtime versions;
  // the codex smoke never hits that branch, so an empty-status stub suffices.
  const providerHealthStub = Layer.succeed(input.runtime.ProviderHealth, {
    getStatuses: Effect.succeed([]),
  } as never);
  const baseLayer = Layer.mergeAll(
    makeConfigLayer(input.runtime, input.paths),
    input.runtime.ServerSettingsService.layerTest(),
    makeRegistryLayer(input.runtime, input.invocations, input.paths),
    providerHealthStub,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = input.runtime.ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));

  const program = Effect.gen(function* () {
    const discovery = (yield* Effect.service(
      input.runtime.ProviderDiscoveryService,
    )) as SmokeProviderDiscoveryService;
    const operations: MossProviderDiscoverySmokeOperation[] = [];

    operations.push(
      yield* discovery.getComposerCapabilities({ provider: PROVIDER }).pipe(
        Effect.match({
          onFailure: (error) => operationFail("getComposerCapabilities", error),
          onSuccess: (capabilities) =>
            operationPass({
              id: "getComposerCapabilities",
              source: RUNTIME_BOUNDARY,
              count: 1,
              items: [capabilities.provider],
              supportsSkillDiscovery: capabilities.supportsSkillDiscovery,
              supportsPluginDiscovery: capabilities.supportsPluginDiscovery,
              supportsRuntimeModelList: capabilities.supportsRuntimeModelList,
            }),
        }),
      ),
    );

    operations.push(
      yield* discovery
        .listSkills({
          provider: PROVIDER,
          cwd: input.paths.cwd,
          forceReload: true,
        })
        .pipe(
          Effect.match({
            onFailure: (error) => operationFail("listSkills", error),
            onSuccess: (skills) =>
              operationPass({
                id: "listSkills",
                source: skills.source,
                count: skills.skills.length,
                items: skills.skills.map((skill) => skill.name),
              }),
          }),
        ),
    );

    operations.push(
      yield* discovery
        .listPlugins({
          provider: PROVIDER,
          cwd: input.paths.cwd,
          forceReload: true,
        })
        .pipe(
          Effect.match({
            onFailure: (error) => operationFail("listPlugins", error),
            onSuccess: (plugins) =>
              operationPass({
                id: "listPlugins",
                source: plugins.source,
                count: plugins.marketplaces.reduce(
                  (count, marketplace) => count + marketplace.plugins.length,
                  0,
                ),
                items: plugins.marketplaces.flatMap((marketplace) =>
                  marketplace.plugins.map((plugin) => plugin.name),
                ),
              }),
          }),
        ),
    );

    operations.push(
      yield* discovery
        .listModels({
          provider: PROVIDER,
          cwd: input.paths.cwd,
        })
        .pipe(
          Effect.match({
            onFailure: (error) => operationFail("listModels", error),
            onSuccess: (models) =>
              operationPass({
                id: "listModels",
                source: models.source,
                count: models.models.length,
                items: models.models.map((model) => model.slug),
              }),
          }),
        ),
    );

    return operations;
  }).pipe(Effect.provide(testLayer));

  return Effect.runPromise(
    program as unknown as Effect.Effect<
      ReadonlyArray<MossProviderDiscoverySmokeOperation>,
      never,
      never
    >,
  );
}

function includesAll(
  actual: ReadonlyArray<string> | undefined,
  expected: ReadonlyArray<string>,
): boolean {
  const set = new Set(actual ?? []);
  return expected.every((entry) => set.has(entry));
}

function computeReadiness(
  operations: ReadonlyArray<MossProviderDiscoverySmokeOperation>,
): MossProviderDiscoverySmokeReport["readiness"] {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const allPresent = REQUIRED_OPERATION_IDS.every((id) => byId.has(id));
  const allPass = operations.every((operation) => operation.status === "pass");
  const capabilities = byId.get("getComposerCapabilities");
  const skills = byId.get("listSkills");
  const plugins = byId.get("listPlugins");
  const models = byId.get("listModels");
  const expectationsPass =
    capabilities?.supportsSkillDiscovery === true &&
    capabilities.supportsPluginDiscovery === true &&
    capabilities.supportsRuntimeModelList === true &&
    includesAll(skills?.items, REQUIRED_SKILL_NAMES) &&
    includesAll(plugins?.items, REQUIRED_PLUGIN_NAMES) &&
    includesAll(models?.items, REQUIRED_MODEL_SLUGS);

  if (allPresent && allPass && expectationsPass) {
    return {
      status: "pass",
      summary:
        "Provider discovery smoke passed through ProviderDiscoveryService for capabilities, skills, plugins, and models.",
    };
  }

  return {
    status: "fail",
    summary:
      "Provider discovery smoke failed; one or more discovery operations or expected runtime items are missing.",
  };
}

export async function runMossProviderDiscoverySmoke(
  options: MossProviderDiscoverySmokeOptions = {},
): Promise<MossProviderDiscoverySmokeReport> {
  const runtime = await loadProviderDiscoveryRuntime();
  runtime.clearSkillsCatalogCacheForTests();
  const createdAt = options.createdAt ?? new Date().toISOString();
  const paths = makeRuntimePaths(resolve(options.cwd ?? process.cwd()));
  const invocations: string[] = [];

  try {
    seedSmokeRuntime(paths);
    const operations = await runProviderDiscoveryOperations({ paths, invocations, runtime });
    return {
      version: 1,
      createdAt,
      provider: PROVIDER,
      cwd: paths.cwd,
      runtimeBoundary: RUNTIME_BOUNDARY,
      providerCredentialsRequired: false,
      writesGlobalConfig: false,
      requiredOperations: REQUIRED_OPERATION_IDS,
      adapterInvocationOrder: invocations,
      operations,
      expectations: {
        skillNames: REQUIRED_SKILL_NAMES,
        pluginNames: REQUIRED_PLUGIN_NAMES,
        modelSlugs: REQUIRED_MODEL_SLUGS,
      },
      readiness: computeReadiness(operations),
    };
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
}

export function writeMossProviderDiscoverySmokeReport(
  report: MossProviderDiscoverySmokeReport,
  reportPath: string,
): void {
  const absolutePath = resolve(process.cwd(), reportPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function mossProviderDiscoverySmokeExitCode(
  report: MossProviderDiscoverySmokeReport,
): number {
  return report.readiness.status === "pass" ? 0 : 1;
}

function parseCliArgs(argv: ReadonlyArray<string>): {
  readonly createdAt: string;
  readonly reportPath: string;
} {
  let createdAt: string | undefined;
  let reportPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--created-at") {
      createdAt = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--report") {
      reportPath = argv[index + 1];
      index += 1;
      continue;
    }
  }

  const effectiveCreatedAt = createdAt ?? new Date().toISOString();
  return {
    createdAt: effectiveCreatedAt,
    reportPath: reportPath ?? defaultReportPath(effectiveCreatedAt),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { createdAt, reportPath } = parseCliArgs(process.argv.slice(2));
  const report = await runMossProviderDiscoverySmoke({ createdAt });
  writeMossProviderDiscoverySmokeReport(report, reportPath);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  process.exitCode = mossProviderDiscoverySmokeExitCode(report);
}
