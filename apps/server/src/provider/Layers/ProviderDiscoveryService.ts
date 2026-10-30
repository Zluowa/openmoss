import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderComposerCapabilities,
  ProviderGetComposerCapabilitiesInput,
  type ProviderKind,
  ProviderListAgentsInput,
  ProviderListCommandsInput,
  ProviderListModelsInput,
  type ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderModelDescriptor,
  ProviderAddMarketplaceInput,
  type ProviderCatalogEntry,
  type ProviderCatalogResourceKind,
  ProviderInstallPluginInput,
  ProviderListAppsInput,
  ProviderReadAppToolsInput,
  ProviderReadAppConnectorInput,
  ProviderReadAppConnectorTermsInput,
  ProviderStartAppConnectionInput,
  ProviderCompleteAppConnectionInput,
  ProviderListMcpInput,
  type ProviderListMcpResult,
  type ProviderMcpServerDescriptor,
  ProviderListSkillsInput,
  type ProviderListSkillsResult,
  ProviderReadPluginInput,
  ProviderRemoveMarketplaceInput,
  ProviderSetAppEnabledInput,
  ProviderSetPluginEnabledInput,
  type ProviderSetPluginEnabledResult,
  ProviderUninstallPluginInput,
  ProviderUpgradeMarketplaceInput,
  type ProviderListPluginsResult,
  type ProviderStartOptions,
  type ProviderSkillDescriptor,
  PROVIDER_PLUGIN_LISTING_LOAD_ERROR_SUFFIX,
  isSupportedProviderKind,
} from "@synara/contracts";
import {
  providerStartOptionsFromInstance,
  resolveProviderInstance,
} from "@synara/shared/providerInstances";
import { Effect, Exit, Layer, Option, Queue, Schema, SchemaIssue, Semaphore } from "effect";

import { ServerConfig } from "../../config.ts";
import { gateBetaOnlyProviders, ServerSettingsService } from "../../serverSettings.ts";
import { ProviderValidationError } from "../Errors.ts";
import type { ProviderDiscoveryError } from "../Services/ProviderDiscoveryService.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderHealth } from "../Services/ProviderHealth.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryCatalogSelectionBoundary,
  type ProviderDiscoveryCatalogSelectionIssueInput,
  type ProviderDiscoveryCatalogSelectionVerifyInput,
  type ProviderDiscoveryServiceShape,
} from "../Services/ProviderDiscoveryService.ts";
import {
  MossMarketplaceSelectionTicketError,
  MossMarketplaceSelectionTicketService,
} from "../mossMarketplaceSelectionTicket.ts";
import { browseMossMarketplace } from "../mossMarketplaceAggregation.ts";
import { discoverMcpCatalog } from "../mcpCatalog.ts";
import {
  discoverMossPluginCatalog,
  isMossPluginMarketplacePath,
  readMossPluginDetail,
} from "../pluginsCatalog.ts";
import { discoverMossPluginRuntime } from "../mossPluginRuntime.ts";
import type { MossPluginProductionApprovalService } from "../mossPluginApprovalService.ts";
import {
  CurrentMossProjectionAuthorityContext,
  type MossProjectionAuthorityFactory,
} from "../mossProjectionAuthorityFactory.ts";
import {
  type PersistedModelCatalogEntryInput,
  makeProviderModelDiscoveryCache,
  providerModelDiscoveryCacheKey,
} from "../providerModelDiscoveryCache.ts";
import {
  readProviderModelCatalogCache,
  resolveProviderModelCatalogCachePath,
  writeProviderModelCatalogCache,
} from "../providerModelCatalogCache.ts";
import {
  discoverSkillsCatalog,
  filterDisabledSkills,
  mergeSkillsIntoCatalog,
} from "../skillsCatalog.ts";

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

const disabledCapabilitiesForProvider = (
  provider: ProviderComposerCapabilities["provider"],
): ProviderComposerCapabilities => ({
  provider,
  supportsSkillMentions: false,
  supportsSkillDiscovery: false,
  supportsNativeSlashCommandDiscovery: false,
  supportsPluginMentions: false,
  supportsPluginDiscovery: false,
  supportsRuntimeModelList: false,
  supportsThreadCompaction: false,
  supportsThreadImport: false,
});

const decodeProviderModelDescriptorOption = Schema.decodeUnknownOption(ProviderModelDescriptor);

function isolateMalformedModelDescriptors(input: {
  readonly provider: ProviderListModelsInput["provider"];
  readonly result: ProviderListModelsResult;
}): Effect.Effect<ProviderListModelsResult> {
  const models = input.result.models.flatMap((model) => {
    const decoded = decodeProviderModelDescriptorOption(model);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
  const omittedCount = input.result.models.length - models.length;
  if (omittedCount === 0) {
    return Effect.succeed(input.result);
  }
  return Effect.logWarning("provider model discovery omitted malformed descriptors", {
    provider: input.provider,
    source: input.result.source ?? "unknown",
    omittedCount,
  }).pipe(
    Effect.as({
      ...input.result,
      models,
    }),
  );
}

const PROVIDER_DISCOVERY_OPTION_KEYS = {
  codex: ["binaryPath", "homePath", "shadowHomePath", "accountId", "environment"],
  claudeAgent: ["binaryPath", "homePath", "environment"],
  cursor: ["binaryPath", "apiEndpoint", "environment"],
  gemini: ["binaryPath", "environment"],
  devin: ["binaryPath", "environment"],
  antigravity: ["binaryPath", "environment"],
  grok: ["binaryPath", "environment"],
  droid: ["binaryPath", "environment"],
  opencode: ["binaryPath", "serverUrl", "serverPassword", "experimentalWebSockets", "environment"],
  pi: ["binaryPath", "agentDir", "environment"],
  hermes: ["binaryPath", "homePath", "environment"],
  omp: ["binaryPath", "agentDir", "environment"],
  kimi: ["binaryPath", "homePath", "environment"],
  minimax: ["binaryPath", "homePath", "environment"],
  zcode: ["binaryPath", "homePath", "environment"],
} as const satisfies Partial<Record<ProviderKind, readonly string[]>>;

export interface ProviderDiscoveryServiceLiveOptions {
  /** Server-owned authorization action; never a workspace-provided issuer. */
  readonly pluginApprovalService?: MossPluginProductionApprovalService;
  /** Resolves the same connection/workspace-scoped authority used by ProviderService. */
  readonly projectionAuthorityFactory?: MossProjectionAuthorityFactory;
}

const mcpCatalogReadAdmission = Semaphore.makeUnsafe(1);

type ProviderDiscoveryCatalogLookup = (input: {
  readonly kind: ProviderCatalogResourceKind;
  readonly candidateId: string;
}) => Promise<ProviderCatalogEntry | null>;

export function createProviderDiscoveryCatalogSelectionBoundary(options: {
  readonly lookup: ProviderDiscoveryCatalogLookup;
  readonly ticketService?: MossMarketplaceSelectionTicketService;
}): ProviderDiscoveryCatalogSelectionBoundary {
  const ticketService = options.ticketService ?? new MossMarketplaceSelectionTicketService();
  const selectionTicketValidationError = (operation: string, error: unknown) =>
    new ProviderValidationError({
      operation,
      issue:
        error instanceof MossMarketplaceSelectionTicketError
          ? error.code
          : "Catalog selection ticket validation failed.",
      cause: error,
    });
  const lookup = async (input: {
    readonly kind: ProviderCatalogResourceKind;
    readonly candidateId: string;
  }): Promise<ProviderCatalogEntry> => {
    const candidateId = input.candidateId.trim();
    if (!candidateId) {
      throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_INVALID");
    }
    const entry = await options.lookup({ ...input, candidateId });
    if (!entry || entry.kind !== input.kind || entry.id !== candidateId) {
      throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_INVALID");
    }
    return entry;
  };
  const issue = (input: ProviderDiscoveryCatalogSelectionIssueInput) =>
    Effect.tryPromise({
      try: async () =>
        ticketService.issue({
          entry: await lookup(input),
          authenticatedActorId: input.authenticatedActorId,
          selectionContext: input.selectionContext,
          ...(input.artifact !== undefined ? { artifact: input.artifact } : {}),
        }),
      catch: (error) =>
        selectionTicketValidationError("ProviderDiscoveryService.catalogSelection.issue", error),
    });
  const verify = (input: ProviderDiscoveryCatalogSelectionVerifyInput) =>
    Effect.tryPromise({
      try: async () =>
        ticketService.verify(
          {
            token: input.token,
            currentEntry: await lookup(input),
            authenticatedActorId: input.authenticatedActorId,
            selectionContext: input.selectionContext,
            ...(input.artifact !== undefined ? { artifact: input.artifact } : {}),
          },
          ...(input.consume === undefined ? [] : [{ consume: input.consume }]),
        ),
      catch: (error) =>
        selectionTicketValidationError("ProviderDiscoveryService.catalogSelection.verify", error),
    });
  return { issue, verify };
}

const make = (options: ProviderDiscoveryServiceLiveOptions = {}) =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    const serverConfig = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const providerHealth = yield* ProviderHealth;
    // One catalog cache for every provider: adapters that spawn a CLI/ACP process
    // per listModels call share stale-while-revalidate, single-flight, and
    // failure-replay behaviour with adapters that reuse a running process.
    // Snapshots persist to stateDir so a restart reopens the picker with
    // last-known models instead of a fresh discovery wait.
    const resolveProjectionAuthorityForMutation = (operation: string) =>
      Effect.gen(function* () {
        if (!options.projectionAuthorityFactory) {
          return yield* new ProviderValidationError({
            operation,
            issue: "A server-scoped workspace authority is required for Moss plugin mutation.",
          });
        }
        const context = yield* CurrentMossProjectionAuthorityContext;
        if (!context) {
          return yield* new ProviderValidationError({
            operation,
            issue: "A server-scoped workspace authority is required for Moss plugin mutation.",
          });
        }
        const authority = yield* Effect.tryPromise(() =>
          options.projectionAuthorityFactory!.resolve(context),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderValidationError({
                operation,
                issue: "The server-scoped workspace authority is unavailable.",
                cause,
              }),
          ),
        );
        if (!authority) {
          return yield* new ProviderValidationError({
            operation,
            issue: "The registered workspace or authenticated connection is unavailable.",
          });
        }
        return yield* Effect.try({
          try: () => {
            authority.assertLive();
            return authority;
          },
          catch: (cause) =>
            new ProviderValidationError({
              operation,
              issue: "The server-scoped workspace authority handle is stale or revoked.",
              cause,
            }),
        });
      });
    const selectionTicketService = new MossMarketplaceSelectionTicketService();
    const catalogSelection = createProviderDiscoveryCatalogSelectionBoundary({
      ticketService: selectionTicketService,
      lookup: async ({ kind, candidateId }) => {
        const page = await browseMossMarketplace({
          kind,
          stateDir: serverConfig.stateDir,
          forceReload: true,
          query: { query: candidateId, includeStale: true, limit: 100 },
        });
        return (
          page.entries.find((entry) => entry.kind === kind && entry.id === candidateId) ?? null
        );
      },
    });

    const catalogCachePath = resolveProviderModelCatalogCachePath({
      stateDir: serverConfig.stateDir,
    });
    const persistedCatalogs = yield* readProviderModelCatalogCache(catalogCachePath);
    // Writes serialize through a queue so concurrent cache mutations can't race
    // the atomic file write.
    const catalogWriteQueue =
      yield* Queue.unbounded<ReadonlyArray<PersistedModelCatalogEntryInput>>();
    const writeCatalogSnapshot = (entries: ReadonlyArray<PersistedModelCatalogEntryInput>) =>
      writeProviderModelCatalogCache({ filePath: catalogCachePath, entries }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist provider model catalogs", {
            path: catalogCachePath,
            issues: cause.toString(),
          }),
        ),
      );
    // Registered before the writer fiber: finalizers run LIFO, so at scope close
    // the writer is interrupted first and this then drains anything still queued.
    // The newest snapshot always reaches disk even on shutdown.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        // Queue.takeAll would block on an empty queue; takeUnsafe drains
        // synchronously so the newest queued snapshot wins.
        let latest: ReadonlyArray<PersistedModelCatalogEntryInput> | undefined;
        for (
          let taken = Queue.takeUnsafe(catalogWriteQueue);
          taken !== undefined;
          taken = Queue.takeUnsafe(catalogWriteQueue)
        ) {
          if (Exit.isSuccess(taken)) latest = taken.value;
        }
        return latest === undefined ? Effect.void : writeCatalogSnapshot(latest);
      }),
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(Queue.take(catalogWriteQueue), (first) => {
          // Coalesce bursts: each queued item is a full snapshot, so drain to the
          // newest before writing (e.g. several providers discovered at boot).
          let latest = first;
          for (
            let taken = Queue.takeUnsafe(catalogWriteQueue);
            taken !== undefined;
            taken = Queue.takeUnsafe(catalogWriteQueue)
          ) {
            if (Exit.isSuccess(taken)) latest = taken.value;
          }
          return writeCatalogSnapshot(latest);
        }),
      ),
    );
    const modelDiscoveryCache = makeProviderModelDiscoveryCache<ProviderDiscoveryError>({
      persistedCatalogs,
      onCatalogsChanged: (entries) => {
        Queue.offerUnsafe(catalogWriteQueue, entries);
      },
    });
    const applyProviderStartOptions = <T extends { readonly provider: ProviderKind }>(
      parsed: T,
      providerOptions: ProviderStartOptions | undefined,
      replaceProviderOptions: boolean,
    ): T => {
      const base = { ...parsed } as Record<string, unknown>;
      if (replaceProviderOptions) {
        const optionKeys = isSupportedProviderKind(parsed.provider)
          ? (PROVIDER_DISCOVERY_OPTION_KEYS[parsed.provider] ?? [])
          : [];
        for (const key of optionKeys) {
          delete base[key];
        }
      }
      // Kilo is retired and has no start-options slot; it decodes to opencode.
      const providerConfig =
        parsed.provider === "kilo" ? undefined : providerOptions?.[parsed.provider];
      if (!providerConfig || typeof providerConfig !== "object") {
        return base as T;
      }
      const overlay = Object.fromEntries(
        Object.entries(providerConfig).filter(([, value]) => value !== undefined && value !== ""),
      );
      return { ...base, ...overlay } as T;
    };

    const resolveDiscoveryInput = <
      T extends { readonly provider: ProviderKind; readonly instanceId?: string | undefined },
    >(
      parsed: T,
    ): Effect.Effect<
      T & {
        readonly provider: ProviderKind;
        readonly instanceId: string;
        readonly instanceEnabled: boolean;
      },
      ProviderValidationError,
      never
    > =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.orElseSucceed(() => gateBetaOnlyProviders(DEFAULT_SERVER_SETTINGS)),
        );
        const instance = resolveProviderInstance(settings, {
          provider: parsed.provider,
          ...(parsed.instanceId ? { instanceId: parsed.instanceId } : {}),
        });
        if (!instance) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.resolveDiscoveryInput",
            issue: `Unknown provider instance '${parsed.instanceId}'.`,
          });
        }
        if (parsed.provider !== instance.driver) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.resolveDiscoveryInput",
            issue: `Requested provider '${parsed.provider}' does not match provider instance '${instance.instanceId}' driver '${instance.driver}'.`,
          });
        }
        const resolved = {
          ...parsed,
          provider: instance.driver as ProviderKind,
          instanceId: instance.instanceId,
          instanceEnabled: instance.enabled,
        } as T & {
          readonly provider: ProviderKind;
          readonly instanceId: string;
          readonly instanceEnabled: boolean;
        };
        return instance.enabled
          ? applyProviderStartOptions(
              resolved,
              providerStartOptionsFromInstance(instance),
              parsed.instanceId !== undefined,
            )
          : resolved;
      });

    const getComposerCapabilities: ProviderDiscoveryServiceShape["getComposerCapabilities"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.getComposerCapabilities",
          schema: ProviderGetComposerCapabilitiesInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        if (!resolved.instanceEnabled) {
          return disabledCapabilitiesForProvider(resolved.provider);
        }
        const adapter = yield* registry.getByProvider(resolved.provider);
        const capabilities = adapter.getComposerCapabilities
          ? yield* adapter.getComposerCapabilities()
          : disabledCapabilitiesForProvider(resolved.provider);
        // The unified Moss skills catalog backs skill discovery for every
        // provider, including ones without native skill support.
        return {
          ...capabilities,
          supportsSkillMentions: true,
          supportsSkillDiscovery: true,
        };
      });

    const listSkills: ProviderDiscoveryServiceShape["listSkills"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.listSkills",
          schema: ProviderListSkillsInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        if (!resolved.instanceEnabled) {
          return {
            skills: [],
            source: "disabled",
            cached: false,
          };
        }
        const adapter = yield* registry.getByProvider(resolved.provider);
        const nativeResult: ProviderListSkillsResult | null = adapter.listSkills
          ? yield* adapter
              .listSkills(resolved)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    "provider-native skill discovery failed; serving the Moss skills catalog only",
                    { provider: resolved.provider, error },
                  ).pipe(Effect.as(null)),
                ),
              )
          : null;
        const catalogSkills = yield* Effect.tryPromise(() =>
          discoverSkillsCatalog({
            cwd: parsed.cwd,
            homeDir: serverConfig.homeDir,
            mossBaseDir: serverConfig.baseDir,
            provider: resolved.provider,
            ...(parsed.forceReload !== undefined ? { forceReload: parsed.forceReload } : {}),
            ...(parsed.agentDir !== undefined ? { agentDir: parsed.agentDir } : undefined),
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("moss skills catalog discovery failed", {
              provider: resolved.provider,
              cause,
            }).pipe(Effect.as([] as ProviderSkillDescriptor[])),
          ),
        );
        const merged = mergeSkillsIntoCatalog({
          native: nativeResult?.skills ?? [],
          catalog: catalogSkills,
        });
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.orElseSucceed(() => gateBetaOnlyProviders(DEFAULT_SERVER_SETTINGS)),
        );
        return {
          skills: parsed.includeDisabled
            ? merged
            : filterDisabledSkills(merged, settings.skills.disabled),
          source: nativeResult?.source ? `${nativeResult.source}+moss.catalog` : "moss.catalog",
          cached: nativeResult?.cached ?? false,
        } satisfies ProviderListSkillsResult;
      });

    const listCommands: ProviderDiscoveryServiceShape["listCommands"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.listCommands",
          schema: ProviderListCommandsInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        if (!resolved.instanceEnabled) {
          return {
            commands: [],
            source: "disabled",
            cached: false,
          };
        }
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.listCommands) {
          return {
            commands: [],
            source: "unsupported",
            cached: false,
          };
        }
        if (resolved.provider !== "claudeAgent") {
          return yield* adapter.listCommands(resolved);
        }
        // Server-owned like the session start options, so discovery lists the
        // same commands a new Claude session will actually have.
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.orElseSucceed(() => gateBetaOnlyProviders(DEFAULT_SERVER_SETTINGS)),
        );
        return yield* adapter.listCommands({
          ...resolved,
          enableArtifacts: settings.providers.claudeAgent.enableArtifacts,
        });
      });

    const listPlugins: ProviderDiscoveryServiceShape["listPlugins"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.listPlugins",
          schema: ProviderListPluginsInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        if (!resolved.instanceEnabled) {
          return {
            marketplaces: [],
            marketplaceLoadErrors: [],
            remoteSyncError: null,
            featuredPluginIds: [],
            source: "disabled",
            cached: false,
          };
        }
        const adapter = yield* registry.getByProvider(resolved.provider);
        const nativeResult: ProviderListPluginsResult = adapter.listPlugins
          ? yield* adapter.listPlugins(resolved).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "provider-native plugin discovery failed; serving the Moss plugin catalog only",
                  { provider: resolved.provider, error },
                ).pipe(
                  Effect.as({
                    marketplaces: [],
                    marketplaceLoadErrors: [
                      {
                        marketplacePath: `${resolved.provider}${PROVIDER_PLUGIN_LISTING_LOAD_ERROR_SUFFIX}`,
                        message:
                          error instanceof Error
                            ? error.message
                            : "Provider-native plugin discovery failed.",
                      },
                    ],
                    remoteSyncError: null,
                    featuredPluginIds: [],
                    source: "error",
                    cached: false,
                  } satisfies ProviderListPluginsResult),
                ),
              ),
            )
          : {
              marketplaces: [],
              marketplaceLoadErrors: [],
              remoteSyncError: null,
              featuredPluginIds: [],
              source: "unsupported",
              cached: false,
            };
        const mossCatalog = yield* Effect.tryPromise(() =>
          discoverMossPluginCatalog({ cwd: parsed.cwd ?? null }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("moss plugin catalog discovery failed", {
              provider: parsed.provider,
              cause,
            }).pipe(Effect.as({ marketplace: null, loadErrors: [] })),
          ),
        );
        const mossMarketplace = mossCatalog.marketplace;
        const nativeMarketplaces = mossMarketplace
          ? nativeResult.marketplaces.filter(
              (marketplace) => marketplace.path !== mossMarketplace.path,
            )
          : nativeResult.marketplaces;
        const remoteCatalog = parsed.catalog
          ? yield* Effect.tryPromise(() =>
              browseMossMarketplace({
                kind: "plugin",
                stateDir: serverConfig.stateDir,
                query: parsed.catalog,
                forceReload: parsed.forceReload,
              }),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("remote Moss plugin catalog discovery failed", {
                  provider: resolved.provider,
                  cause,
                }).pipe(Effect.as(undefined)),
              ),
            )
          : undefined;
        return {
          ...nativeResult,
          marketplaces: mossMarketplace
            ? [mossMarketplace, ...nativeMarketplaces]
            : nativeMarketplaces,
          marketplaceLoadErrors: [...mossCatalog.loadErrors, ...nativeResult.marketplaceLoadErrors],
          source: mossMarketplace
            ? nativeResult.source
              ? `${nativeResult.source}+moss.plugins`
              : "moss.plugins"
            : nativeResult.source,
          ...(remoteCatalog ? { catalog: remoteCatalog } : {}),
        } satisfies ProviderListPluginsResult;
      });

    const readPlugin: ProviderDiscoveryServiceShape["readPlugin"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.readPlugin",
          schema: ProviderReadPluginInput,
          payload: input,
        });
        if (
          typeof parsed.marketplacePath === "string" &&
          isMossPluginMarketplacePath(parsed.marketplacePath)
        ) {
          const marketplacePath = parsed.marketplacePath;
          return yield* Effect.tryPromise(() =>
            readMossPluginDetail({
              marketplacePath,
              pluginName: parsed.pluginName,
            }),
          ).pipe(
            Effect.map((plugin) => ({
              plugin,
              source: "moss.plugins",
              cached: false,
            })),
            Effect.mapError(
              (error) =>
                new ProviderValidationError({
                  operation: "ProviderDiscoveryService.readPlugin",
                  issue: error instanceof Error ? error.message : String(error),
                  cause: error,
                }),
            ),
          );
        }
        const resolved = yield* resolveDiscoveryInput(parsed);
        if (!resolved.instanceEnabled) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.readPlugin",
            issue: `Provider instance '${resolved.instanceId}' is disabled in Moss settings.`,
          });
        }
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.readPlugin) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.readPlugin",
            issue: `Plugin discovery is unavailable for provider '${resolved.provider}'.`,
          });
        }
        return yield* adapter.readPlugin(resolved);
      });

    const installPlugin: ProviderDiscoveryServiceShape["installPlugin"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.installPlugin",
          schema: ProviderInstallPluginInput,
          payload: input,
        });
        if (
          typeof parsed.marketplacePath === "string" &&
          isMossPluginMarketplacePath(parsed.marketplacePath)
        ) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.installPlugin",
            issue: "Moss catalog resources are not native Codex plugins.",
          });
        }
        const resolved = yield* resolveDiscoveryInput(parsed);
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.installPlugin) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.installPlugin",
            issue: `Plugin installation is unavailable for provider '${resolved.provider}'.`,
          });
        }
        return yield* adapter.installPlugin(resolved);
      });

    const addMarketplace: ProviderDiscoveryServiceShape["addMarketplace"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.addMarketplace",
          schema: ProviderAddMarketplaceInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.addMarketplace) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.addMarketplace",
            issue: `Marketplace installation is unavailable for provider '${resolved.provider}'.`,
          });
        }
        return yield* adapter.addMarketplace(resolved);
      });

    const removeMarketplace: ProviderDiscoveryServiceShape["removeMarketplace"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.removeMarketplace",
          schema: ProviderRemoveMarketplaceInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.removeMarketplace) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.removeMarketplace",
            issue: `Marketplace removal is unavailable for provider '${resolved.provider}'.`,
          });
        }
        return yield* adapter.removeMarketplace(resolved);
      });

    const upgradeMarketplace: ProviderDiscoveryServiceShape["upgradeMarketplace"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.upgradeMarketplace",
          schema: ProviderUpgradeMarketplaceInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.upgradeMarketplace) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.upgradeMarketplace",
            issue: `Marketplace upgrades are unavailable for provider '${resolved.provider}'.`,
          });
        }
        return yield* adapter.upgradeMarketplace(resolved);
      });

    const uninstallPlugin: ProviderDiscoveryServiceShape["uninstallPlugin"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.uninstallPlugin",
          schema: ProviderUninstallPluginInput,
          payload: input,
        });
        if (parsed.pluginId.startsWith("moss:")) {
          if (!parsed.cwd || !options.pluginApprovalService) {
            return yield* new ProviderValidationError({
              operation: "ProviderDiscoveryService.uninstallPlugin",
              issue: "Moss plugin authorization is unavailable on this server boundary.",
            });
          }
          const projectionAuthority = yield* resolveProjectionAuthorityForMutation(
            "ProviderDiscoveryService.uninstallPlugin",
          );
          yield* Effect.promise(() =>
            options.pluginApprovalService!.revoke({
              cwd: parsed.cwd!,
              pluginId: parsed.pluginId,
              ...(projectionAuthority ? { projectionAuthority } : {}),
            }),
          );
          return {};
        }
        const cwd = parsed.cwd;
        if (cwd) {
          const mossCatalog = yield* Effect.tryPromise(() =>
            discoverMossPluginCatalog({ cwd }),
          ).pipe(
            Effect.mapError(
              (error) =>
                new ProviderValidationError({
                  operation: "ProviderDiscoveryService.uninstallPlugin",
                  issue: "Unable to verify canonical Moss plugin ownership.",
                  cause: error,
                }),
            ),
          );
          if (mossCatalog.marketplace?.plugins.some((plugin) => plugin.id === parsed.pluginId)) {
            return yield* new ProviderValidationError({
              operation: "ProviderDiscoveryService.uninstallPlugin",
              issue: "Moss catalog resources must be removed through the canonical resource API.",
            });
          }
        }
        const resolved = yield* resolveDiscoveryInput(parsed);
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.uninstallPlugin) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.uninstallPlugin",
            issue: `Plugin removal is unavailable for provider '${resolved.provider}'.`,
          });
        }
        return yield* adapter.uninstallPlugin(resolved);
      });

    const setPluginEnabled: ProviderDiscoveryServiceShape["setPluginEnabled"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.setPluginEnabled",
          schema: ProviderSetPluginEnabledInput,
          payload: input,
        });
        if (parsed.pluginId.startsWith("moss:")) {
          if (!parsed.cwd || !options.pluginApprovalService) {
            return yield* new ProviderValidationError({
              operation: "ProviderDiscoveryService.setPluginEnabled",
              issue: "Moss plugin authorization is unavailable on this server boundary.",
            });
          }
          const runtime = yield* Effect.tryPromise(() =>
            discoverMossPluginRuntime({ cwd: parsed.cwd! }),
          ).pipe(
            Effect.mapError(
              (error) =>
                new ProviderValidationError({
                  operation: "ProviderDiscoveryService.setPluginEnabled",
                  issue: "Unable to discover the canonical Moss plugin for authorization.",
                  cause: error,
                }),
            ),
          );
          const plugin = runtime.plugins.find((candidate) => candidate.id === parsed.pluginId);
          if (!plugin) {
            return yield* new ProviderValidationError({
              operation: "ProviderDiscoveryService.setPluginEnabled",
              issue: `Canonical Moss plugin '${parsed.pluginId}' was not found in the workspace.`,
            });
          }
          const projectionAuthority = yield* resolveProjectionAuthorityForMutation(
            "ProviderDiscoveryService.setPluginEnabled",
          );
          yield* Effect.tryPromise(() =>
            options.pluginApprovalService!.authorize({
              cwd: parsed.cwd!,
              plugin,
              enabled: parsed.enabled,
              ...(projectionAuthority ? { projectionAuthority } : {}),
            }),
          ).pipe(
            Effect.mapError(
              (error) =>
                new ProviderValidationError({
                  operation: "ProviderDiscoveryService.setPluginEnabled",
                  issue: error instanceof Error ? error.message : String(error),
                  cause: error,
                }),
            ),
          );
          return { status: "ok" } satisfies ProviderSetPluginEnabledResult;
        }
        const cwd = parsed.cwd;
        if (cwd) {
          const mossCatalog = yield* Effect.tryPromise(() =>
            discoverMossPluginCatalog({ cwd }),
          ).pipe(
            Effect.mapError(
              (error) =>
                new ProviderValidationError({
                  operation: "ProviderDiscoveryService.setPluginEnabled",
                  issue: "Unable to verify canonical Moss plugin ownership.",
                  cause: error,
                }),
            ),
          );
          if (mossCatalog.marketplace?.plugins.some((plugin) => plugin.id === parsed.pluginId)) {
            return yield* new ProviderValidationError({
              operation: "ProviderDiscoveryService.setPluginEnabled",
              issue: "Moss catalog resources must be updated through the canonical resource API.",
            });
          }
        }
        const resolved = yield* resolveDiscoveryInput(parsed);
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.setPluginEnabled) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.setPluginEnabled",
            issue: `Plugin configuration is unavailable for provider '${resolved.provider}'.`,
          });
        }
        return yield* adapter.setPluginEnabled(resolved);
      });

    const listApps: ProviderDiscoveryServiceShape["listApps"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.listApps",
          schema: ProviderListAppsInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.listApps) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.listApps",
            issue: `App discovery is unavailable for provider '${resolved.provider}'.`,
          });
        }
        return yield* adapter.listApps(resolved);
      });

    const setAppEnabled: ProviderDiscoveryServiceShape["setAppEnabled"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.setAppEnabled",
          schema: ProviderSetAppEnabledInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.setAppEnabled) {
          return yield* new ProviderValidationError({
            operation: "ProviderDiscoveryService.setAppEnabled",
            issue: `App configuration is unavailable for provider '${resolved.provider}'.`,
          });
        }
        return yield* adapter.setAppEnabled(resolved);
      });

    const connectorOperation = <
      K extends
        | "readAppTools"
        | "readAppConnector"
        | "readAppConnectorTerms"
        | "startAppConnection"
        | "completeAppConnection",
    >(
      name: K,
      schema:
        | typeof ProviderReadAppToolsInput
        | typeof ProviderReadAppConnectorInput
        | typeof ProviderReadAppConnectorTermsInput
        | typeof ProviderStartAppConnectionInput
        | typeof ProviderCompleteAppConnectionInput,
      input: Parameters<ProviderDiscoveryServiceShape[K]>[0],
    ) =>
      Effect.gen(function* () {
        const operation = `ProviderDiscoveryService.${name}`;
        const parsed = yield* decodeInputOrValidationError({ operation, schema, payload: input });
        const resolved = yield* resolveDiscoveryInput(parsed);
        const adapter = yield* registry.getByProvider(resolved.provider);
        const method = adapter[name];
        if (!method) {
          return yield* new ProviderValidationError({
            operation,
            issue: `App connector operations are unavailable for provider '${resolved.provider}'.`,
          });
        }
        return yield* method(resolved as never);
      }) as ReturnType<ProviderDiscoveryServiceShape[K]>;

    const readAppTools: ProviderDiscoveryServiceShape["readAppTools"] = (input) =>
      connectorOperation("readAppTools", ProviderReadAppToolsInput, input);
    const readAppConnector: ProviderDiscoveryServiceShape["readAppConnector"] = (input) =>
      connectorOperation("readAppConnector", ProviderReadAppConnectorInput, input);
    const readAppConnectorTerms: ProviderDiscoveryServiceShape["readAppConnectorTerms"] = (input) =>
      connectorOperation("readAppConnectorTerms", ProviderReadAppConnectorTermsInput, input);
    const startAppConnection: ProviderDiscoveryServiceShape["startAppConnection"] = (input) =>
      connectorOperation("startAppConnection", ProviderStartAppConnectionInput, input);
    const completeAppConnection: ProviderDiscoveryServiceShape["completeAppConnection"] = (input) =>
      connectorOperation("completeAppConnection", ProviderCompleteAppConnectionInput, input);

    const listMcp: ProviderDiscoveryServiceShape["listMcp"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.listMcp",
          schema: ProviderListMcpInput,
          payload: input,
        });
        const servers = yield* Effect.tryPromise(() =>
          discoverMcpCatalog({
            cwd: parsed.cwd ?? null,
            homeDir: serverConfig.homeDir,
            mossBaseDir: serverConfig.baseDir,
            provider: parsed.provider,
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("moss mcp catalog discovery failed", {
              provider: parsed.provider,
              cause,
            }).pipe(Effect.as([] as ProviderMcpServerDescriptor[])),
          ),
        );
        const remoteCatalog = parsed.catalog
          ? yield* mcpCatalogReadAdmission
              .withPermitsIfAvailable(1)(
                Effect.tryPromise(() =>
                  browseMossMarketplace({
                    kind: "mcp",
                    stateDir: serverConfig.stateDir,
                    query: parsed.catalog,
                    forceReload: parsed.forceReload,
                  }),
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("remote Moss MCP catalog discovery failed", {
                      provider: parsed.provider,
                      cause,
                    }).pipe(Effect.as(undefined)),
                  ),
                ),
              )
              .pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.logWarning("remote Moss MCP catalog admission busy", {
                        provider: parsed.provider,
                      }).pipe(Effect.as(undefined)),
                    onSome: Effect.succeed,
                  }),
                ),
              )
          : undefined;
        return {
          servers,
          source: "moss.mcp-catalog",
          cached: false,
          ...(remoteCatalog ? { catalog: remoteCatalog } : {}),
        } satisfies ProviderListMcpResult;
      });

    const listModels: ProviderDiscoveryServiceShape["listModels"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.listModels",
          schema: ProviderListModelsInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        if (!resolved.instanceEnabled) {
          return {
            models: [],
            source: "disabled",
            cached: false,
          };
        }
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.listModels) {
          return {
            models: [],
            source: "unsupported",
            cached: false,
          };
        }
        const listModelsFromAdapter = adapter.listModels;
        const discover = Effect.suspend(() => listModelsFromAdapter(resolved)).pipe(
          Effect.flatMap((result) =>
            isolateMalformedModelDescriptors({ provider: resolved.provider, result }),
          ),
        );
        // OMP re-resolves file-backed modelRoles per request, so a shared fresh
        // window would freeze role/config edits for up to 30 minutes and persist
        // them across restarts. `omp models` is a cheap subprocess — bypass the
        // shared cache so every picker read reflects the live catalog.
        if (resolved.provider === "omp") {
          return yield* discover;
        }
        const cacheKey = providerModelDiscoveryCacheKey(resolved);
        const runtimeVersion =
          resolved.provider === "claudeAgent"
            ? ((yield* providerHealth.getStatuses).find(
                (status) =>
                  status.provider === "claudeAgent" && status.instanceId === resolved.instanceId,
              )?.version ?? null)
            : undefined;
        return yield* modelDiscoveryCache.lookup(
          { ...cacheKey, ...(runtimeVersion !== undefined ? { runtimeVersion } : {}) },
          discover,
          parsed.refresh,
        );
      });

    const listAgents: ProviderDiscoveryServiceShape["listAgents"] = (input) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderDiscoveryService.listAgents",
          schema: ProviderListAgentsInput,
          payload: input,
        });
        const resolved = yield* resolveDiscoveryInput(parsed);
        if (!resolved.instanceEnabled) {
          return {
            agents: [],
            source: "disabled",
            cached: false,
          };
        }
        const adapter = yield* registry.getByProvider(resolved.provider);
        if (!adapter.listAgents) {
          return {
            agents: [],
            source: "unsupported",
            cached: false,
          };
        }
        return yield* adapter.listAgents(resolved);
      });

    return {
      catalogSelection,
      getComposerCapabilities,
      listCommands,
      listSkills,
      listPlugins,
      readPlugin,
      addMarketplace,
      removeMarketplace,
      upgradeMarketplace,
      installPlugin,
      uninstallPlugin,
      setPluginEnabled,
      listApps,
      setAppEnabled,
      readAppTools,
      readAppConnector,
      readAppConnectorTerms,
      startAppConnection,
      completeAppConnection,
      listModels,
      listAgents,
      listMcp,
    } satisfies ProviderDiscoveryServiceShape;
  });

export const ProviderDiscoveryServiceLive = Layer.effect(ProviderDiscoveryService, make());

export function makeProviderDiscoveryServiceLive(options?: ProviderDiscoveryServiceLiveOptions) {
  return Layer.effect(ProviderDiscoveryService, make(options));
}
