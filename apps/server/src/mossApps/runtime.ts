// FILE: runtime.ts
// Purpose: Cache Apps catalog and account-scoped state behind the existing connector.
// Layer: Desktop server. Uses Moss login credentials, never a Composio project key.
import type {
  MossAppConnection,
  MossAppToolkit,
  MossAppsConnectFieldsResult,
  MossAppsConnectResult,
  MossAppsListToolkitsInput,
  MossAppsListToolkitsResult,
  MossAppsStatus,
} from "@moss/contracts";
import { MOSS_APPS_DISPLAY_NAME, MOSS_APPS_SERVER_NAME } from "@moss/shared/mossAppsPresentation";
import type { AgentGatewayConnectorRegistration } from "../agentGateway/Services/AgentGatewayCredentials";
import type { MossLoginCredential } from "../account/mossLoginAuthority";
import { jsonRpcErrorResult, type McpConnectorProxyResult } from "../mcpConnectors/proxy";
import type { McpConnectorForwardRequest } from "../mcpConnectors/runtime";
import { appsAuthorityKey, MossAppsFailure, type MossAppsGateway } from "./gatewayClient";
export { MossAppsFailure, MOSS_APPS_DISPLAY_NAME, MOSS_APPS_SERVER_NAME };
export const MOSS_APPS_CONNECTOR_ID = "moss_apps";

export interface MossAppsRuntimeDeps {
  readonly client: MossAppsGateway;
  readonly callbackUrl: () => string;
  readonly publish: (registration: AgentGatewayConnectorRegistration | null) => void;
  readonly logWarning: (message: string) => void;
  readonly now?: () => number;
}
interface Context {
  credential: MossLoginCredential;
  key: string;
  epoch: number;
  signal: AbortSignal;
}
interface Cached<A> {
  at: number;
  value: A;
}

export class MossAppsRuntime {
  private readonly now: () => number;
  private identity: string | null = null;
  private epoch = 0;
  private authorityRequest = 0;
  private acceptedAuthorityRequest = 0;
  private statusRequest = 0;
  private controller = new AbortController();
  private disposed = false;
  private agentAccess = false;
  private availability: MossAppsStatus["availability"] = "authentication-required";
  private connections: Cached<readonly MossAppConnection[]> | null = null;
  private readonly toolkits = new Map<string, Cached<MossAppsListToolkitsResult>>();
  private readonly forms = new Map<string, Cached<MossAppsConnectFieldsResult>>();
  private readonly callbacks = new Map<
    string,
    { connectionId: string; key: string; expires: number }
  >();
  private catalog: Cached<MossAppsListToolkitsResult> | null = null;
  private catalogPending: {
    key: string;
    epoch: number;
    promise: Promise<MossAppsListToolkitsResult>;
  } | null = null;

  constructor(private readonly deps: MossAppsRuntimeDeps) {
    this.now = deps.now ?? Date.now;
  }
  get configured(): boolean {
    return true;
  }
  private resetIdentity(key: string | null): void {
    if (this.identity === key) return;
    this.controller.abort();
    this.controller = new AbortController();
    this.epoch += 1;
    this.identity = key;
    this.connections = null;
    this.callbacks.clear();
    this.catalogPending = null;
    this.publishAccess(false);
  }
  dispose(): void {
    this.disposed = true;
    this.resetIdentity(null);
    this.controller.abort();
  }
  /** Called at account mutations, also checked before every cache read and reply. */
  async refreshIdentity(): Promise<void> {
    try {
      await this.context();
    } catch {
      /* context clears the previous owner first. */
    }
  }
  private async context(signal?: AbortSignal): Promise<Context> {
    if (this.disposed) throw MossAppsFailure.fromCode("apps_unavailable");
    const request = ++this.authorityRequest;
    let credential: MossLoginCredential;
    try {
      credential = await this.deps.client.authority();
    } catch (error) {
      if (request < this.acceptedAuthorityRequest)
        throw MossAppsFailure.fromCode("account_changed");
      this.acceptedAuthorityRequest = request;
      this.resetIdentity(null);
      const failure =
        error instanceof MossAppsFailure
          ? error
          : MossAppsFailure.fromCode("authentication_required");
      this.availability =
        failure.code === "apps_login_account_required"
          ? "login-account-required"
          : "authentication-required";
      throw failure;
    }
    if (this.disposed) throw MossAppsFailure.fromCode("apps_unavailable");
    const key = appsAuthorityKey(credential);
    // A slow A lookup must not reset a controller already owned by B. A same
    // identity token refresh remains compatible with concurrent reads.
    if (request < this.acceptedAuthorityRequest && key !== this.identity)
      throw MossAppsFailure.fromCode("account_changed");
    this.acceptedAuthorityRequest = Math.max(request, this.acceptedAuthorityRequest);
    this.resetIdentity(key);
    return {
      credential,
      key,
      epoch: this.epoch,
      signal: signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal,
    };
  }
  private async current(context: Context): Promise<void> {
    const latest = await this.context();
    if (context.signal.aborted || latest.key !== context.key || latest.epoch !== context.epoch)
      throw MossAppsFailure.fromCode("account_changed");
  }
  private async call<A>(run: (context: Context) => Promise<A>, signal?: AbortSignal): Promise<A> {
    const context = await this.context(signal);
    try {
      const value = await run(context);
      await this.current(context);
      return value;
    } catch (error) {
      if (error instanceof MossAppsFailure) throw error;
      throw MossAppsFailure.fromCode("apps_unavailable");
    }
  }
  async init(signal?: AbortSignal): Promise<void> {
    await this.listConnections(signal ? { signal } : {}).catch(() =>
      this.deps.logWarning("Moss Apps is waiting for an available login and regional service."),
    );
  }
  async status(): Promise<MossAppsStatus> {
    const request = ++this.statusRequest;
    let context: Context | undefined;
    try {
      context = await this.context();
      const availability = await this.deps.client.status(context.credential, context.signal);
      await this.current(context);
      if (request === this.statusRequest) this.availability = availability;
    } catch {
      if (
        request === this.statusRequest &&
        context &&
        context.key === this.identity &&
        context.epoch === this.epoch &&
        !context.signal.aborted
      )
        this.availability = "unavailable";
    }
    return { availability: this.availability, agentAccess: this.agentAccess };
  }
  async listToolkits(input: MossAppsListToolkitsInput): Promise<MossAppsListToolkitsResult> {
    return this.call(async (context) => {
      const key = JSON.stringify(input);
      const cached = input.all ? this.catalog : this.toolkits.get(key);
      if (cached && this.now() - cached.at < (input.all ? 60 * 60_000 : 5 * 60_000))
        return cached.value;
      if (
        input.all &&
        this.catalogPending?.key === context.key &&
        this.catalogPending.epoch === context.epoch
      )
        return this.catalogPending.promise;
      const promise = this.deps.client.listToolkits(context.credential, input, context.signal);
      const pending = { key: context.key, epoch: context.epoch, promise };
      if (input.all) this.catalogPending = pending;
      let value: MossAppsListToolkitsResult;
      try {
        value = await promise;
      } finally {
        if (this.catalogPending === pending) this.catalogPending = null;
      }
      await this.current(context);
      const entry = { at: this.now(), value };
      if (input.all) this.catalog = entry;
      else {
        this.toolkits.set(key, entry);
        this.trim(this.toolkits);
      }
      return value;
    });
  }
  cachedToolkit(slug: string): MossAppToolkit | null {
    return this.catalog?.value.toolkits.find((toolkit) => toolkit.slug === slug) ?? null;
  }
  async listConnections(
    options: { fresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<readonly MossAppConnection[]> {
    return this.call(async (context) => {
      if (!options.fresh && this.connections && this.now() - this.connections.at < 15_000)
        return this.connections.value;
      const value = await this.deps.client.listConnections(context.credential, context.signal);
      await this.current(context);
      this.connections = { at: this.now(), value };
      this.publishAccess(value.some((connection) => connection.status === "active"));
      return value;
    }, options.signal);
  }
  async connectFields(toolkitSlug: string): Promise<MossAppsConnectFieldsResult> {
    return this.call(async (context) => {
      const cached = this.forms.get(toolkitSlug);
      if (cached && this.now() - cached.at < 60 * 60_000) return cached.value;
      const value = await this.deps.client.connectFields(
        context.credential,
        toolkitSlug,
        context.signal,
      );
      await this.current(context);
      this.forms.set(toolkitSlug, { at: this.now(), value });
      this.trim(this.forms);
      return value;
    });
  }
  async connect(
    toolkitSlug: string,
    credentials?: Readonly<Record<string, string>>,
  ): Promise<MossAppsConnectResult> {
    return this.call(async (context) => {
      const value = await this.deps.client.connect(
        context.credential,
        {
          toolkitSlug,
          callbackUrl: this.deps.callbackUrl(),
          ...(credentials ? { credentials } : {}),
        },
        context.signal,
      );
      await this.current(context);
      this.connections = null;
      if (value.callbackState && value.signInUrl) {
        this.callbacks.set(value.callbackState, {
          connectionId: value.connection.connectionId,
          key: context.key,
          expires: this.now() + 10 * 60_000,
        });
        this.trim(this.callbacks);
      }
      if (value.connection.status === "active") this.publishAccess(true);
      return { signInUrl: value.signInUrl, connection: value.connection };
    });
  }
  async completeAuthorization(query: {
    state?: string;
    connectionId?: string;
    failed?: boolean;
  }): Promise<boolean> {
    if (!query.state) return false;
    const pending = this.callbacks.get(query.state);
    this.callbacks.delete(query.state);
    if (
      !pending ||
      pending.expires <= this.now() ||
      query.failed ||
      (query.connectionId !== undefined && query.connectionId !== pending.connectionId)
    )
      return false;
    try {
      return await this.call(async (context) => {
        if (context.key !== pending.key) return false;
        const ok = await this.deps.client.complete(
          context.credential,
          {
            state: query.state!,
            connectionId: pending.connectionId,
            callbackUrl: this.deps.callbackUrl(),
          },
          context.signal,
        );
        await this.current(context);
        if (ok) {
          this.connections = null;
          this.publishAccess(true);
        }
        return ok;
      });
    } catch {
      return false;
    }
  }
  async disconnect(connectionId: string): Promise<boolean> {
    return this.call(async (context) => {
      const removed = await this.deps.client.disconnect(
        context.credential,
        connectionId,
        context.signal,
      );
      await this.current(context);
      this.connections = null;
      this.publishAccess(false);
      // A successful deletion must not be replayed because the follow-up read
      // failed. Keep access revoked until fresh owned connections are known.
      try {
        const remaining = await this.deps.client.listConnections(
          context.credential,
          context.signal,
        );
        await this.current(context);
        this.connections = { at: this.now(), value: remaining };
        this.publishAccess(remaining.some((connection) => connection.status === "active"));
      } catch {
        /* A later connections read can restore access. */
      }
      return removed;
    });
  }
  async forward(request: McpConnectorForwardRequest): Promise<McpConnectorProxyResult> {
    try {
      return await this.call(async (context) => {
        if (request.authorityKey !== context.key || !request.isAuthorized?.())
          throw MossAppsFailure.fromCode("account_changed");
        const result = await this.deps.client.forward(context.credential, request, context.signal);
        if (!request.isAuthorized()) throw MossAppsFailure.fromCode("account_changed");
        return result;
      }, request.signal);
    } catch {
      return jsonRpcErrorResult(request.body, "Moss could not reach your apps. Try again shortly.");
    }
  }
  private trim<K, V>(map: Map<K, V>): void {
    while (map.size > 64) map.delete(map.keys().next().value!);
  }
  private publishAccess(value: boolean): void {
    if (value === this.agentAccess) return;
    this.agentAccess = value;
    this.deps.publish(
      value
        ? {
            name: MOSS_APPS_SERVER_NAME,
            connectorId: MOSS_APPS_CONNECTOR_ID,
            authorityKey: this.identity!,
          }
        : null,
    );
  }
}
