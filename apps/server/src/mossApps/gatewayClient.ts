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
import { outboundHttp } from "@moss/shared/outboundHttp";
import type { MossLoginCredential } from "../account/mossLoginAuthority";
import { forwardMcpConnectorRequest } from "../mcpConnectors/proxy";
import type { McpConnectorForwardRequest } from "../mcpConnectors/runtime";

const messages: Readonly<Record<string, string>> = {
  authentication_required: "Sign in to Moss to connect your apps.",
  apps_login_account_required: "Switch to your phone or Google account to use Moss Apps.",
  account_recovery_required: "Sign in to Moss again to use your apps.",
  apps_unconfigured: "Moss Apps is not available in this region yet.",
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

export const appsAuthorityKey = (credential: MossLoginCredential) =>
  `${credential.realm}\0${credential.account.id}\0${credential.gatewayBaseUrl}`;

export class MossAppsGatewayClient {
  constructor(readonly authority: () => Promise<MossLoginCredential>) {}

  private url(credential: MossLoginCredential, route: string): string {
    return `${credential.gatewayBaseUrl.replace(/\/+$/u, "")}/v1/apps/${route}`;
  }

  private async request(
    credential: MossLoginCredential,
    route: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const url = this.url(credential, route);
    const response = await outboundHttp.request({
      policy: {
        service: "moss-apps-gateway",
        allowedOrigins: [new URL(url).origin],
        timeoutMs: 60_000,
        maxRequestBytes: 64 * 1024,
        maxResponseBytes: 4 * 1024 * 1024,
        maxRedirects: 0,
        maxConcurrent: 4,
        maxQueued: 16,
        requirePublicAddress: true,
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
      const code =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "object" &&
        parsed.error !== null &&
        "code" in parsed.error &&
        typeof parsed.error.code === "string"
          ? parsed.error.code
          : "apps_unavailable";
      throw MossAppsFailure.fromCode(code);
    }
    return parsed;
  }

  async status(
    credential: MossLoginCredential,
    signal: AbortSignal,
  ): Promise<"ready" | "unconfigured"> {
    const value = await this.request(credential, "status", undefined, signal);
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
