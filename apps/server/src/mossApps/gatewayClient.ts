// FILE: gatewayClient.ts
// Purpose: Desktop Apps client using only the selected Moss login's regional bearer.
// Layer: Server. Provider project keys and upstream router URLs never enter this module.
import { Schema } from "effect";
import {
  MossAppsConnectFieldsResult,
  MossAppsConnectResult,
  MossAppsListConnectionsResult,
  MossAppsListToolkitsResult,
  type MossAppsListToolkitsInput,
} from "@moss/contracts";
import {
  OutboundHttpError,
  outboundHttp,
  resolveOutboundProxyUrl,
} from "@moss/shared/outboundHttp";
import { withOutboundProxyEnv } from "@moss/shared/outboundProxy";
import type { MossLoginCredential } from "../account/mossLoginAuthority";
import { isMossConnectionLevelFailure } from "../account/mossServiceEntries";
import { forwardMcpConnectorRequest } from "../mcpConnectors/proxy";
import type { McpConnectorForwardRequest } from "../mcpConnectors/runtime";

const messages: Readonly<Record<string, string>> = {
  authentication_required: "Sign in to Moss to connect your apps.",
  apps_login_account_required:
    "Enterprise API keys don't support connecting external apps yet. Sign in with your phone or Google account to use Moss Apps.",
  account_recovery_required: "Sign in to Moss again to use your apps.",
  apps_unconfigured: "Moss Apps isn't available yet.",
  apps_credentials_required: "Enter the details this app asks for.",
  apps_credentials_unavailable: "This app does not sign in with a key or login.",
  account_changed: "Your Moss account changed. Try again.",
  apps_unavailable: "Moss could not reach your apps. Try again shortly.",
};

export class MossAppsFailure extends Error {
  override readonly name = "MossAppsFailure";
  constructor(
    message: string,
    readonly code = "apps_unavailable",
  ) {
    super(message);
  }
  static fromCode(code: string) {
    return new MossAppsFailure(messages[code] ?? messages.apps_unavailable!, code);
  }
}

// The account, not the gateway entry: a CN failover to another entry of the same gateway is
// the same Apps authority and must not read as an account change mid-request.
export const appsAuthorityKey = (credential: MossLoginCredential) =>
  `${credential.realm}\0${credential.account.id}`;

/**
 * The gateway serves Apps at `<function>/v1/apps/<route>`: `supabase/functions/
 * moss-model-gateway/mossApps.ts` strips `/functions/v1/moss-model-gateway`, then needs
 * `/v1/apps/`. The configured base is the model API base, which already ends in `/v1`.
 */
export function mossAppsGatewayUrl(gatewayBaseUrl: string, route: string): string {
  const functionBase = gatewayBaseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  return `${functionBase}/v1/apps/${route}`;
}

function gatewayErrorCode(parsed: unknown): string | null {
  return typeof parsed === "object" &&
    parsed !== null &&
    "error" in parsed &&
    typeof parsed.error === "object" &&
    parsed.error !== null &&
    "code" in parsed.error &&
    typeof parsed.error.code === "string"
    ? parsed.error.code
    : null;
}

const sameEntry = (a: string, b: string) => a.replace(/\/+$/u, "") === b.replace(/\/+$/u, "");

const isAppsConnectionFailure = (error: unknown) =>
  isMossConnectionLevelFailure(error) ||
  (error instanceof OutboundHttpError && error.code === "timeout");

export class MossAppsGatewayClient {
  constructor(readonly authority: () => Promise<MossLoginCredential>) {}

  private url(credential: MossLoginCredential, route: string): string {
    return mossAppsGatewayUrl(credential.gatewayBaseUrl, route);
  }

  /**
   * One Apps call on the gateway entry in use. A failure below HTTP (a reset, refused or
   * timed-out connection) is reported to the gateway's entry router, as the model catalogue
   * does, and the call is made once more on the entry the router picks.
   */
  private async request(
    credential: MossLoginCredential,
    route: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.requestAt(credential.gatewayBaseUrl, credential, route, body, signal);
    } catch (error) {
      if (
        error instanceof MossAppsFailure ||
        signal.aborted ||
        !credential.reportGatewayConnectionFailure ||
        !isAppsConnectionFailure(error)
      )
        throw error;
      const next = await credential.reportGatewayConnectionFailure(credential.gatewayBaseUrl);
      if (!next || sameEntry(next, credential.gatewayBaseUrl)) throw error;
      try {
        return await this.requestAt(next, credential, route, body, signal);
      } catch (retryError) {
        if (!signal.aborted && isAppsConnectionFailure(retryError))
          await credential.reportGatewayConnectionFailure(next).catch(() => undefined);
        throw retryError;
      }
    }
  }

  private async requestAt(
    gatewayBaseUrl: string,
    credential: MossLoginCredential,
    route: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const url = mossAppsGatewayUrl(gatewayBaseUrl, route);
    const proxyUrl = resolveOutboundProxyUrl(url, withOutboundProxyEnv(process.env));
    const response = await outboundHttp.request({
      policy: {
        service: "moss-apps-gateway",
        allowedOrigins: [new URL(url).origin],
        timeoutMs: 60_000,
        maxRequestBytes: 64 * 1024,
        maxResponseBytes: 16 * 1024 * 1024,
        maxRedirects: 0,
        maxConcurrent: 4,
        maxQueued: 16,
        requirePublicAddress: true,
        ...(proxyUrl ? { proxyUrl } : {}),
        allowBenchmarkAddressRange: true,
      },
      url,
      method: body === undefined ? "GET" : "POST",
      signal,
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
    } catch {
      throw MossAppsFailure.fromCode("apps_unavailable");
    }
    if (response.status < 200 || response.status >= 300) {
      const code = gatewayErrorCode(parsed);
      // A gateway deployed without the Apps module answers with its model router's 404: Apps
      // is not offered there yet. That is a calm state, not a failure to retry.
      if (response.status === 404 && code === "unsupported_endpoint")
        throw MossAppsFailure.fromCode("apps_unconfigured");
      throw MossAppsFailure.fromCode(code ?? "apps_unavailable");
    }
    return parsed;
  }

  async status(
    credential: MossLoginCredential,
    signal: AbortSignal,
  ): Promise<"ready" | "unconfigured"> {
    let value: unknown;
    try {
      value = await this.request(credential, "status", undefined, signal);
    } catch (error) {
      if (error instanceof MossAppsFailure && error.code === "apps_unconfigured")
        return "unconfigured";
      throw error;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "availability" in value &&
      (value.availability === "ready" || value.availability === "unconfigured")
    )
      return value.availability;
    throw MossAppsFailure.fromCode("apps_unavailable");
  }
  async listToolkits(
    credential: MossLoginCredential,
    input: MossAppsListToolkitsInput,
    signal: AbortSignal,
  ) {
    return Schema.decodeUnknownSync(MossAppsListToolkitsResult)(
      await this.request(credential, "toolkits", input, signal),
    );
  }
  async listConnections(credential: MossLoginCredential, signal: AbortSignal) {
    return Schema.decodeUnknownSync(MossAppsListConnectionsResult)(
      await this.request(credential, "connections", undefined, signal),
    ).connections;
  }
  async connectFields(credential: MossLoginCredential, toolkitSlug: string, signal: AbortSignal) {
    return Schema.decodeUnknownSync(MossAppsConnectFieldsResult)(
      await this.request(credential, "connect-fields", { toolkitSlug }, signal),
    );
  }
  async connect(
    credential: MossLoginCredential,
    input: {
      toolkitSlug: string;
      callbackUrl: string;
      credentials?: Readonly<Record<string, string>>;
    },
    signal: AbortSignal,
  ) {
    const value = await this.request(credential, "connect", input, signal);
    const result = Schema.decodeUnknownSync(MossAppsConnectResult)(value);
    const callbackState =
      typeof value === "object" &&
      value !== null &&
      "callbackState" in value &&
      typeof value.callbackState === "string" &&
      value.callbackState.length <= 2048
        ? value.callbackState
        : null;
    return { ...result, callbackState };
  }
  async disconnect(
    credential: MossLoginCredential,
    connectionId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const value = await this.request(credential, "disconnect", { connectionId }, signal);
    return (
      typeof value === "object" && value !== null && "removed" in value && value.removed === true
    );
  }
  async complete(
    credential: MossLoginCredential,
    input: { state: string; connectionId: string; callbackUrl: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    const value = await this.request(credential, "complete", input, signal);
    return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
  }
  forward(
    credential: MossLoginCredential,
    request: McpConnectorForwardRequest,
    signal: AbortSignal,
  ) {
    return forwardMcpConnectorRequest(
      { ...request, url: this.url(credential, "mcp"), accessToken: credential.accessToken, signal },
      "Moss Apps",
    );
  }
}

export type MossAppsGateway = Pick<
  MossAppsGatewayClient,
  | "authority"
  | "status"
  | "listToolkits"
  | "listConnections"
  | "connectFields"
  | "connect"
  | "disconnect"
  | "complete"
  | "forward"
>;
