/**
 * McpConnectorsLive - Connectors backed by the server secret store.
 *
 * The whole connector document (names, URLs, OAuth tokens) is one secret-store
 * entry: a 0600 file in this app's data home. Connected connectors are handed
 * to AgentGatewayCredentials so new provider sessions receive their proxies.
 *
 * Moss Apps (hosted third-party apps) join the same registration as one more
 * connector, `moss_apps`, so every provider reaches every connected app
 * through a single proxied MCP server. Its project key comes from
 * MOSS_COMPOSIO_API_KEY and never leaves this process.
 *
 * @module mcpConnectors/Layers/McpConnectors
 */
import { MCP_CONNECTORS_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { randomUUID } from "node:crypto";

import { Effect, Layer } from "effect";

import { version } from "../../../package.json" with { type: "json" };
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { createLogger } from "../../logger.ts";
import { jsonRpcErrorResult } from "../proxy.ts";
import { McpConnectorFailure, McpConnectorRuntime } from "../runtime.ts";
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
export const MOSS_APPS_CALLBACK_PATH = "/oauth/moss-apps/callback";
const MOSS_APPS_USER_SECRET_NAME = "moss-apps-user";
export const MOSS_APPS_API_KEY_ENV = "MOSS_COMPOSIO_API_KEY";

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
    ...(cause instanceof McpConnectorFailure && cause.code ? { code: cause.code } : {}),
    cause,
  });

export const makeMcpConnectors = (options: { readonly enabled?: boolean } = {}) =>
  Effect.gen(function* () {
    const enabled = options.enabled ?? isServerBetaFeatureEnabled(MCP_CONNECTORS_BETA_FEATURE);
    const secretStore = yield* ServerSecretStore;
    const credentials = yield* AgentGatewayCredentials;

    // User connectors and Moss Apps share one registration in the gateway.
    let userRegistrations: ReadonlyArray<AgentGatewayConnectorRegistration> = [];
    let appsRegistration: AgentGatewayConnectorRegistration | null = null;
    const publishAll = () =>
      credentials.setConnectorServers?.(
        appsRegistration ? [...userRegistrations, appsRegistration] : userRegistrations,
      );

    // One opaque id per Moss home names this user to the app backend.
    let appsUserId: Promise<string> | null = null;
    const resolveAppsUserId = () => {
      appsUserId ??= Effect.runPromise(
        Effect.gen(function* () {
          const saved = yield* secretStore.get(MOSS_APPS_USER_SECRET_NAME);
          if (saved) return new TextDecoder().decode(saved);
          const created = `moss_${randomUUID()}`;
          yield* secretStore.set(MOSS_APPS_USER_SECRET_NAME, new TextEncoder().encode(created));
          return created;
        }),
      );
      const pending = appsUserId;
      pending.catch(() => {
        if (appsUserId === pending) appsUserId = null;
      });
      return pending;
    };
    const apps = new MossAppsRuntime({
      apiKey: process.env[MOSS_APPS_API_KEY_ENV]?.trim() || null,
      userId: resolveAppsUserId,
      callbackUrl: () => `${new URL(credentials.mcpEndpointUrl).origin}${MOSS_APPS_CALLBACK_PATH}`,
      publish: (registration) => {
        appsRegistration = registration;
        publishAll();
      },
      logWarning: (message, fields) => log.warn(message, fields),
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
      },
      clientVersion: version,
      logWarning: (message, fields) => log.warn(message, fields),
    });
    // Restore only this app's connector document; Stable and Beta have separate homes.
    if (enabled) yield* Effect.promise(() => runtime.init());
    // Startup must not wait on the app backend; the connector appears once it answers.
    void apps.init();

    const unavailable = Effect.fail(
      new McpConnectorError({ message: "Connectors are unavailable on this server." }),
    );

    const appsCall = <A>(run: () => Promise<A>, fallback: string) =>
      Effect.tryPromise({ try: run, catch: toConnectorError(fallback) });

    return {
      enabled,
      gatewayEnabled: enabled || apps.configured,
      mossApps: {
        status: () => Effect.sync(() => apps.status()),
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
