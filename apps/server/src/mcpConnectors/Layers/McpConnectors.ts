/**
 * McpConnectorsLive - Connectors backed by the server secret store.
 *
 * The whole connector document (names, URLs, OAuth tokens) is one secret-store
 * entry: a 0600 file in this app's data home. Connected connectors are handed
 * to AgentGatewayCredentials so new provider sessions receive their proxies.
 *
 * Moss Apps (hosted third-party apps) join the same registration as one more
 * connector, `moss_apps`, so every provider reaches every connected app
 * through a single proxied MCP server. Only the active Moss login reaches
 * the regional Apps gateway; project credentials never enter this process.
 *
 * Mainland China presets ("cn" region) connect and run only while the user
 * is signed in with a phone number; the check reads local account state.
 *
 * Moss service plugins pair those presets with a Moss-written skill. The
 * skill of every installed plugin (connector connected, or a skill-only plugin
 * the user installed, while a phone account is signed in) is kept in Moss's
 * shared skills folder, so installing one plugin gives every CLI both the MCP
 * server and the skill.
 *
 * @module mcpConnectors/Layers/McpConnectors
 */
import type { MossServicePluginsState } from "@moss/contracts";
import { MCP_CONNECTORS_BETA_FEATURE } from "@moss/shared/betaFeatures";
import {
  findMossServicePlugin,
  MOSS_SERVICE_PLUGINS,
  type MossServicePlugin,
} from "@moss/shared/mossServicePlugins";
import { MOSS_APPS_CALLBACK_PATH } from "@moss/shared/mossAppsPresentation";
export { MOSS_APPS_CALLBACK_PATH } from "@moss/shared/mossAppsPresentation";
import { MossCloudAccountService } from "../../account/Services/MossCloudAccountService";
import { MossEnterpriseKeyAccount } from "../../account/Services/MossEnterpriseKeyAccount";
import { resolveMossLoginCredential } from "../../account/mossLoginAuthority";
import { MossAppsGatewayClient } from "../../mossApps/gatewayClient";

import { Effect, Layer, Option, Scope } from "effect";

import { version } from "../../../package.json" with { type: "json" };
import { phoneAccountSignedIn } from "../../account/accountLane.ts";
import { MossPhoneAccountService } from "../../account/Services/MossPhoneAccountService.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { ServerConfig } from "../../config.ts";
import {
  mossServiceSkillFile,
  syncMossServiceSkills,
} from "../../mossServicePlugins/serviceSkills.ts";
import { invalidateSkillsCatalogCache, mossSkillsDir } from "../../provider/skillsCatalog.ts";
import { createLogger } from "../../logger.ts";
import { jsonRpcErrorResult } from "../proxy.ts";
import { McpConnectorFailure, McpConnectorRuntime } from "../runtime.ts";
import { McpAppService } from "../../mcpApps/Services/McpAppService.ts";
import type { AgentGatewayConnectorRegistration } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  MOSS_APPS_CONNECTOR_ID,
  MossAppsFailure,
  MossAppsRuntime,
} from "../../mossApps/runtime.ts";
import {
  McpConnectorError,
  McpConnectors,
  type McpConnectorsShape,
} from "../Services/McpConnectors.ts";

export const MCP_CONNECTORS_SECRET_NAME = "mcp-connectors";
const log = createLogger("mcp-connectors");
export const MCP_CONNECTOR_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";
/** Skill-only service plugins the user installed, as `{ version: 1, installed: [...] }`. */
const MOSS_SERVICE_PLUGINS_SECRET_NAME = "moss-service-plugins";

/** The redirect URL on the port this server listens on (the gateway's origin). */
export function mcpConnectorRedirectUrl(mcpEndpointUrl: string): string {
  return `${new URL(mcpEndpointUrl).origin}${MCP_CONNECTOR_OAUTH_CALLBACK_PATH}`;
}

const toConnectorError = (fallback: string) => (cause: unknown) =>
  new McpConnectorError({
    message:
      cause instanceof McpConnectorFailure || cause instanceof MossAppsFailure
        ? cause.message
        : fallback,
    ...((cause instanceof McpConnectorFailure || cause instanceof MossAppsFailure) && cause.code
      ? { code: cause.code }
      : {}),
    cause,
  });

export const makeMcpConnectors = (options: { readonly enabled?: boolean } = {}) =>
  Effect.gen(function* () {
    const enabled = options.enabled ?? isServerBetaFeatureEnabled(MCP_CONNECTORS_BETA_FEATURE);
    const secretStore = yield* ServerSecretStore;
    const credentials = yield* AgentGatewayCredentials;
    const phoneAccount = yield* Effect.serviceOption(MossPhoneAccountService);
    const cloudAccount = yield* Effect.serviceOption(MossCloudAccountService);
    const enterpriseAccount = yield* Effect.serviceOption(MossEnterpriseKeyAccount);
    const appsScope = yield* Effect.serviceOption(Scope.Scope);
    const mcpApps = Option.getOrUndefined(yield* Effect.serviceOption(McpAppService));
    let connectorsPublishedOnce = false;
    // Local and network-free: the server's one phone-account check.
    const phoneSignedIn = () =>
      Effect.runPromise(phoneAccountSignedIn(Option.getOrUndefined(phoneAccount)));

    // Skill-only service plugins the user installed; plugins with an MCP are
    // installed exactly while their connector exists.
    const serverConfig = yield* Effect.serviceOption(ServerConfig);
    const skillsDir =
      serverConfig._tag === "Some" ? mossSkillsDir(serverConfig.value.baseDir) : null;
    const savedServicePlugins = yield* secretStore.get(MOSS_SERVICE_PLUGINS_SECRET_NAME).pipe(
      Effect.map((bytes) => {
        try {
          const parsed: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
          const ids =
            parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { installed?: unknown }).installed)
              ? ((parsed as { installed: unknown[] }).installed.filter(
                  (id) => typeof id === "string",
                ) as string[])
              : [];
          return ids.filter((id) => findMossServicePlugin(id)?.connectorPresetId === null);
        } catch {
          return [];
        }
      }),
      Effect.catch(() => Effect.succeed([] as string[])),
    );
    let skillOnlyInstalled = new Set<string>(savedServicePlugins);
    let skillSync: Promise<void> = Promise.resolve();
    /** Plugin ids whose skill the last sync left on disk. */
    let syncedSkillPlugins: ReadonlySet<string> = new Set();
    // Installs and uninstalls run one at a time, so two quick ones cannot drop each other.
    let servicePluginWrites: Promise<unknown> = Promise.resolve();

    // User connectors and Moss Apps share one registration in the gateway.
    let userRegistrations: ReadonlyArray<AgentGatewayConnectorRegistration> = [];
    let appsRegistration: AgentGatewayConnectorRegistration | null = null;
    const publishAll = () =>
      credentials.setConnectorServers?.(
        appsRegistration ? [...userRegistrations, appsRegistration] : userRegistrations,
      );

    // Old moss-apps-user secrets/connections are deliberately left untouched.
    // An anonymous home id does not prove ownership by a signed-in account.
    const apps = new MossAppsRuntime({
      client: new MossAppsGatewayClient(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (Option.isSome(enterpriseAccount)) {
              // Credential lookup can return null when its gateway is unconfigured;
              // the selected enterprise account must still own this boundary.
              const state = yield* enterpriseAccount.value
                .getState()
                .pipe(Effect.mapError(() => MossAppsFailure.fromCode("account_recovery_required")));
              if (state.active)
                return yield* Effect.fail(MossAppsFailure.fromCode("apps_login_account_required"));
              const active = yield* enterpriseAccount.value
                .getActiveAuthorityCredential()
                .pipe(Effect.mapError(() => MossAppsFailure.fromCode("account_recovery_required")));
              if (active)
                return yield* Effect.fail(MossAppsFailure.fromCode("apps_login_account_required"));
            }
            if (Option.isNone(phoneAccount) || Option.isNone(cloudAccount))
              return yield* Effect.fail(MossAppsFailure.fromCode("authentication_required"));
            return yield* resolveMossLoginCredential({
              phone: phoneAccount.value,
              cloud: cloudAccount.value,
            }).pipe(Effect.mapError((error) => MossAppsFailure.fromCode(error.code)));
          }),
        ),
      ),
      callbackUrl: () => `${new URL(credentials.mcpEndpointUrl).origin}${MOSS_APPS_CALLBACK_PATH}`,
      publish: (registration) => {
        appsRegistration = registration;
        publishAll();
      },
      logWarning: (message) => log.warn(message),
    });

    const runtime = new McpConnectorRuntime({
      load: () =>
        Effect.runPromise(
          secretStore
            .get(MCP_CONNECTORS_SECRET_NAME)
            .pipe(Effect.map((bytes) => (bytes ? new TextDecoder().decode(bytes) : null))),
        ),
      save: (document) =>
        Effect.runPromise(
          secretStore.set(MCP_CONNECTORS_SECRET_NAME, new TextEncoder().encode(document)),
        ),
      redirectUrl: () => mcpConnectorRedirectUrl(credentials.mcpEndpointUrl),
      publish: (registrations) => {
        userRegistrations = registrations;
        publishAll();
        // Every saved change lands here, so connect and disconnect move the skill too.
        void syncServiceSkills();
        // Interactive connectors: which server names are Moss connectors, and their URLs. A
        // connect or reconnect re-reads that connector's tools (never at boot: no network then).
        if (mcpApps) {
          const connected = runtime.list().filter((connector) => connector.status === "connected");
          mcpApps.setConnectorDirectory(
            connected.map((connector) => ({
              connectorId: connector.connectorId,
              serverName: connector.serverName,
              name: connector.name,
              url: connector.url,
            })),
          );
          if (connectorsPublishedOnce) {
            for (const connector of connected) {
              if (mcpApps.connectorTools(connector.connectorId) !== undefined) continue;
              void mcpApps.refreshConnectorTools(connector.connectorId, (request) =>
                runtime.forward(connector.connectorId, request),
              );
            }
          }
          connectorsPublishedOnce = true;
        }
      },
      clientVersion: version,
      logWarning: (message, fields) => log.warn(message, fields),
      regionAvailable: (region) => (region === "cn" ? phoneSignedIn() : Promise.resolve(true)),
    });
    // An MCP plugin is installed while its connector is connected and working:
    // a rejected key or an expired sign-in shows it as needing a reconnect.
    const installedServicePlugins = (): MossServicePlugin[] => {
      const connected = new Set(
        runtime
          .list()
          .flatMap((connector) =>
            connector.presetId && connector.status === "connected" ? [connector.presetId] : [],
          ),
      );
      return MOSS_SERVICE_PLUGINS.filter((plugin) =>
        plugin.connectorPresetId
          ? connected.has(plugin.connectorPresetId)
          : skillOnlyInstalled.has(plugin.id),
      );
    };
    // Serialized so a quick connect-then-disconnect cannot leave a stale skill.
    // Each pass reads the state when it runs, including the account: a
    // skill-only plugin's skill stays out while no phone account is signed in.
    function syncServiceSkills(): Promise<void> {
      if (!skillsDir) return Promise.resolve();
      const dir = skillsDir;
      skillSync = skillSync
        .then(async () => {
          const phone = await phoneSignedIn();
          const keep = new Set(
            installedServicePlugins()
              .filter((plugin) => plugin.connectorPresetId !== null || phone)
              .map((plugin) => plugin.id),
          );
          await syncMossServiceSkills(dir, keep);
          syncedSkillPlugins = keep;
          invalidateSkillsCatalogCache();
        })
        .catch((error: unknown) => {
          log.warn("Could not update service plugin skills.", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return skillSync;
    }
    const servicePluginsState = (): MossServicePluginsState => ({
      installed: installedServicePlugins().map((plugin) => plugin.id),
      skills: skillsDir
        ? MOSS_SERVICE_PLUGINS.filter((plugin) => syncedSkillPlugins.has(plugin.id)).map(
            (plugin) => ({
              pluginId: plugin.id,
              name: plugin.skill.name,
              path: mossServiceSkillFile(skillsDir, plugin),
            }),
          )
        : [],
    });
    const serializeServicePluginWrite = <A>(run: () => Promise<A>): Promise<A> => {
      const next = servicePluginWrites.then(run);
      servicePluginWrites = next.catch(() => undefined);
      return next;
    };

    // Restore only this app's connector document; Stable and Beta have separate homes.
    if (enabled) yield* Effect.promise(() => runtime.init());
    yield* Effect.promise(() => syncServiceSkills());
    // Network startup is owned by the server scope. Bare unit-test factories
    // without a scope start no background work.
    const startApps = Effect.tryPromise((signal) => apps.init(signal)).pipe(
      Effect.catch(() => Effect.void),
    );
    const refreshApps = Option.isSome(appsScope)
      ? startApps.pipe(Effect.forkIn(appsScope.value), Effect.asVoid)
      : Effect.void;
    if (Option.isSome(appsScope)) {
      yield* Scope.addFinalizer(
        appsScope.value,
        Effect.sync(() => apps.dispose()),
      );
      yield* refreshApps;
    }

    const unavailable = Effect.fail(
      new McpConnectorError({ message: "Connectors are unavailable on this server." }),
    );

    const appsCall = <A>(run: () => Promise<A>, fallback: string) =>
      Effect.tryPromise({ try: run, catch: toConnectorError(fallback) });

    return {
      enabled,
      gatewayEnabled: enabled || apps.configured,
      mossApps: {
        status: () => Effect.promise(() => apps.status()),
        listToolkits: (input) =>
          appsCall(() => apps.listToolkits(input), "Moss could not load apps."),
        listConnections: () =>
          appsCall(() => apps.listConnections(), "Moss could not load your connected apps."),
        connectFields: (toolkitSlug) =>
          appsCall(
            () => apps.connectFields(toolkitSlug),
            "Moss could not load this app's sign-in.",
          ),
        connect: (toolkitSlug, credentials) =>
          appsCall(
            () => apps.connect(toolkitSlug, credentials),
            "Moss could not connect this app.",
          ),
        disconnect: (connectionId) =>
          appsCall(() => apps.disconnect(connectionId), "Moss could not disconnect this app."),
        cachedToolkit: (toolkitSlug) => apps.cachedToolkit(toolkitSlug),
        completeAuthorization: (query) => Effect.promise(() => apps.completeAuthorization(query)),
      },
      servicePlugins: {
        list: () =>
          Effect.promise(async () => {
            await syncServiceSkills();
            return servicePluginsState();
          }),
        setInstalled: (input) =>
          appsCall(
            () =>
              serializeServicePluginWrite(async () => {
                const plugin = findMossServicePlugin(input.pluginId);
                if (!plugin) throw new MossAppsFailure("This plugin is not available.");
                if (plugin.connectorPresetId) {
                  throw new MossAppsFailure("Connect this plugin's service to install it.");
                }
                if (input.installed && !(await phoneSignedIn())) {
                  throw new MossAppsFailure(
                    "This plugin is available only while signed in to Moss with a mainland China phone number.",
                  );
                }
                const next = new Set(skillOnlyInstalled);
                if (input.installed) next.add(plugin.id);
                else next.delete(plugin.id);
                await Effect.runPromise(
                  secretStore.set(
                    MOSS_SERVICE_PLUGINS_SECRET_NAME,
                    new TextEncoder().encode(JSON.stringify({ version: 1, installed: [...next] })),
                  ),
                );
                skillOnlyInstalled = next;
                await syncServiceSkills();
                return servicePluginsState();
              }),
            "Moss could not update this plugin.",
          ),
        resync: () =>
          Effect.promise(() => apps.refreshIdentity()).pipe(
            Effect.andThen(refreshApps),
            Effect.andThen(Effect.promise(() => syncServiceSkills())),
          ),
      },
      list: () => (enabled ? Effect.sync(() => runtime.list()) : unavailable),
      connect: (input) =>
        enabled
          ? Effect.tryPromise({
              try: () => runtime.connect(input),
              catch: toConnectorError("Moss could not connect this server."),
            })
          : unavailable,
      setup: () =>
        enabled
          ? Effect.sync(() => ({
              redirectUrl: mcpConnectorRedirectUrl(credentials.mcpEndpointUrl),
            }))
          : unavailable,
      disconnect: (connectorId) =>
        enabled
          ? Effect.tryPromise({
              try: () => runtime.disconnect(connectorId),
              catch: toConnectorError("Moss could not disconnect this server."),
            })
          : unavailable,
      listTools: (connectorId) =>
        enabled
          ? Effect.tryPromise({
              try: () => runtime.listTools(connectorId),
              catch: toConnectorError("Moss could not list this server's tools."),
            })
          : unavailable,
      completeAuthorization: (query) =>
        enabled
          ? Effect.tryPromise(() => runtime.completeAuthorization(query)).pipe(
              Effect.catch(() =>
                Effect.succeed({
                  ok: false as const,
                  title: "Connection failed",
                  message: "Moss could not finish the sign-in. Try connecting again.",
                }),
              ),
            )
          : Effect.succeed({
              ok: false as const,
              title: "Connectors are unavailable",
              message: "This version of Moss does not support connectors.",
            }),
      forward: (connectorId, request) =>
        Effect.tryPromise((signal) =>
          connectorId === MOSS_APPS_CONNECTOR_ID
            ? apps.forward({ ...request, signal })
            : runtime.forward(connectorId, { ...request, signal }),
        ).pipe(
          Effect.catch(() =>
            Effect.succeed(
              jsonRpcErrorResult(request.body, "Moss could not forward this request."),
            ),
          ),
        ),
    } satisfies McpConnectorsShape;
  });

export const McpConnectorsLive = Layer.effect(McpConnectors, makeMcpConnectors());
