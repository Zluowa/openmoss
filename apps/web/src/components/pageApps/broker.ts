// FILE: broker.ts
// Purpose: The shell-side broker between one running 应用页 frame and Moss.
// Every message from the frame is untrusted: it is decoded, the capability
// must be served on this view (declared by the page, shipped by Moss, allowed
// in this mode), the viewer must have consented, and a rate limit applies,
// before a capability plugin answers it.
// Layer: Web pageApps (framework-free; AppPageFrame wires it to the DOM)

import {
  PAGE_APP_DB_MAX_SUBSCRIPTIONS,
  PAGE_APP_PROTOCOL,
  PageAppFrameMessage,
  type PageAppCallError,
  type PageAppCapabilities,
  type PageAppFrameMode,
  type PageAppId,
  type PageAppPermissionState,
  type PageAppShellMessage,
  type PageAppStoredConsent,
  type PageAppViewer,
} from "@moss/contracts";
import {
  PageAppCapabilityError,
  toPageAppCallError,
  type PageAppConfirmRequest,
  type PageAppConfirmResult,
  type PageAppFrameElement,
  type PageAppShellContext,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";
import { Schema } from "effect";

import type { PageAppsClient } from "./pageAppsClient";
import { TokenBucket } from "./rateLimit";

export interface PageAppBrokerSession {
  readonly appId: PageAppId;
  readonly revision: number;
  readonly title: string;
  readonly mode: PageAppFrameMode;
  readonly viewer: PageAppViewer;
  readonly capabilities: PageAppCapabilities;
  readonly consent: Readonly<Record<string, PageAppStoredConsent>>;
}

export interface PageAppConsentPrompt {
  readonly appTitle: string;
  readonly capabilities: ReadonlyArray<{
    readonly name: string;
    readonly label: string;
    readonly purpose: string;
  }>;
}

export interface PageAppBrokerDeps {
  readonly post: (message: PageAppShellMessage) => void;
  readonly client: Pick<PageAppsClient, "call" | "watch" | "consent">;
  readonly plugins: ReadonlyArray<PageAppShellPlugin>;
  /** One batched consent dialog; resolves true when the viewer allows. */
  readonly askConsent: (prompt: PageAppConsentPrompt) => Promise<boolean>;
  readonly confirm: (request: PageAppConfirmRequest) => Promise<boolean>;
  /** Confirm dialog that also reports its remember checkbox; falls back to `confirm`. */
  readonly confirmChoice?: (request: PageAppConfirmRequest) => Promise<PageAppConfirmResult>;
  readonly frameElement?: () => PageAppFrameElement | null;
  readonly openPermissions: () => Promise<void>;
  readonly onResize?: (height: number) => void;
  readonly onConsentChange?: (consent: Readonly<Record<string, PageAppStoredConsent>>) => void;
  readonly now?: () => number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const MAX_OUTSTANDING_CALLS = 64;
const MAX_MESSAGE_CHARS = 60 * 1024 * 1024;
const decodeFrameMessage = Schema.decodeUnknownExit(PageAppFrameMessage);

/** Capabilities a mode serves; guests never get ones that reach Moss's account. */
const GUEST_EXCLUDED = new Set(["ai", "page"]);

export class PageAppBroker {
  private session: PageAppBrokerSession;
  private consent: Record<string, PageAppStoredConsent>;
  private readonly deniedThisLoad = new Set<string>();
  private readonly watches = new Map<number, () => void>();
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly controller = new AbortController();
  private readonly pluginsByName: Map<string, PageAppShellPlugin>;
  private outstanding = 0;
  private consentQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    session: PageAppBrokerSession,
    private readonly deps: PageAppBrokerDeps,
  ) {
    this.session = session;
    this.consent = { ...session.consent };
    this.pluginsByName = new Map(deps.plugins.map((plugin) => [plugin.name, plugin]));
  }

  /** declared ∩ shipped ∩ allowed in this mode; `permissions` is always served. */
  served(): string[] {
    const names: string[] = [];
    for (const plugin of this.deps.plugins) {
      if (!plugin.modes.includes(this.session.mode)) continue;
      if (this.session.mode === "guest" && GUEST_EXCLUDED.has(plugin.name)) continue;
      if (plugin.name !== "permissions" && !(plugin.name in this.session.capabilities)) continue;
      names.push(plugin.name);
    }
    return names;
  }

  permissionStates(): Record<string, PageAppPermissionState> {
    const states: Record<string, PageAppPermissionState> = {};
    for (const name of this.served()) states[name] = this.stateOf(name);
    return states;
  }

  private stateOf(name: string): PageAppPermissionState {
    const plugin = this.pluginsByName.get(name);
    if (!plugin || !this.served().includes(name)) return "unavailable";
    if (plugin.consent !== "standing") return "granted";
    if (this.deniedThisLoad.has(name) || this.consent[name] === "denied") return "denied";
    return this.consent[name] === "granted" ? "granted" : "prompt";
  }

  /** Forget or set a remembered answer (permissions panel). */
  async setConsent(name: string, state: PageAppStoredConsent | null): Promise<void> {
    const result = await this.deps.client.consent({
      op: "set",
      appId: this.session.appId,
      capability: name,
      state,
    });
    this.consent = { ...result.consent };
    if (state !== "denied") this.deniedThisLoad.delete(name);
    this.deps.onConsentChange?.(this.consent);
  }

  currentConsent(): Readonly<Record<string, PageAppStoredConsent>> {
    return this.consent;
  }

  /** Ask for every name still at "prompt" in one dialog. Serialized. */
  requestPermissions(names?: readonly string[]): Promise<Record<string, PageAppPermissionState>> {
    const run = async () => {
      const wanted = (names ?? this.served()).filter((name) => this.served().includes(name));
      const ask = wanted.filter((name) => this.stateOf(name) === "prompt");
      if (ask.length > 0 && !this.disposed) {
        const allowed = await this.deps.askConsent({
          appTitle: this.session.title,
          capabilities: ask.map((name) => {
            const plugin = this.pluginsByName.get(name)!;
            return { name, label: plugin.label, purpose: plugin.purpose };
          }),
        });
        // A prompt dismissed because the frame went away is no answer: remember nothing.
        if (this.disposed) return {};
        for (const name of ask) {
          if (allowed) await this.setConsent(name, "granted");
          else {
            this.deniedThisLoad.add(name);
            await this.setConsent(name, "denied").catch(() => undefined);
          }
        }
      }
      const out: Record<string, PageAppPermissionState> = {};
      for (const name of names ?? this.served()) out[name] = this.stateOf(name);
      return out;
    };
    const next = this.consentQueue.then(run, run);
    this.consentQueue = next.catch(() => undefined);
    return next;
  }

  private async gate(name: string): Promise<PageAppShellPlugin> {
    const plugin = this.pluginsByName.get(name);
    if (!plugin || !this.served().includes(name))
      throw new PageAppCapabilityError("unavailable", `"${name}" is not available on this page.`);
    if (plugin.consent === "standing") {
      let state = this.stateOf(name);
      if (state === "prompt") state = (await this.requestPermissions([name]))[name] ?? "denied";
      if (state !== "granted")
        throw new PageAppCapabilityError("not_granted", `The viewer did not allow "${name}".`);
    }
    if (plugin.rateLimit) {
      let bucket = this.buckets.get(name);
      if (!bucket) {
        bucket = new TokenBucket(plugin.rateLimit.burst, plugin.rateLimit.perMinute, this.deps.now);
        this.buckets.set(name, bucket);
      }
      if (!bucket.take())
        throw new PageAppCapabilityError(
          "resource_exhausted",
          `Too many "${name}" calls; slow down.`,
        );
    }
    return plugin;
  }

  private context(plugin: PageAppShellPlugin): PageAppShellContext {
    const { session } = this;
    return {
      appId: session.appId,
      revision: session.revision,
      title: session.title,
      mode: session.mode,
      viewer: session.viewer,
      capabilities: session.capabilities,
      config: session.capabilities[plugin.name] ?? {},
      serverCall: async (method, args) =>
        (
          await this.deps.client.call(
            {
              appId: session.appId,
              revision: session.revision,
              capability: plugin.name,
              method,
              args,
            },
            this.controller.signal,
          )
        ).value,
      serverWatch: (method, args, sink) =>
        this.deps.client.watch(
          {
            appId: session.appId,
            revision: session.revision,
            capability: plugin.name,
            method,
            args,
          },
          sink,
        ),
      confirm: (request) => this.deps.confirm(request),
      confirmChoice: (request) =>
        this.deps.confirmChoice
          ? this.deps.confirmChoice(request)
          : this.deps.confirm(request).then((confirmed) => ({ confirmed, remember: false })),
      frameElement: () => this.deps.frameElement?.() ?? null,
      permissionStates: () => this.permissionStates(),
      requestPermissions: (names) => this.requestPermissions(names),
      managePermissions: () => this.deps.openPermissions(),
      signal: this.controller.signal,
    };
  }

  private send(message: DistributiveOmit<PageAppShellMessage, "protocol">) {
    if (this.disposed) return;
    this.deps.post({ protocol: PAGE_APP_PROTOCOL, ...message } as PageAppShellMessage);
  }

  private fail(id: number, error: unknown) {
    this.send({ kind: "result", id, ok: false, error: toPageAppCallError(error) });
  }

  /** Feed one message that already passed the source/origin check. */
  handleMessage(raw: unknown): void {
    if (this.disposed) return;
    if (typeof raw === "string" && raw.length > MAX_MESSAGE_CHARS) return;
    const decoded = decodeFrameMessage(raw);
    if (decoded._tag === "Failure") return;
    const message = decoded.value;
    switch (message.kind) {
      case "hello":
        this.send({ kind: "init", served: this.served() });
        return;
      case "resize":
        if (Number.isFinite(message.height) && message.height >= 0)
          this.deps.onResize?.(Math.min(message.height, 100_000));
        return;
      case "unwatch": {
        const cancel = this.watches.get(message.id);
        this.watches.delete(message.id);
        cancel?.();
        return;
      }
      case "call":
        void this.handleCall(message.id, message.capability, message.method, message.args);
        return;
      case "watch":
        void this.handleWatch(message.id, message.capability, message.method, message.args);
        return;
    }
  }

  private async handleCall(id: number, name: string, method: string, args: unknown) {
    if (this.outstanding >= MAX_OUTSTANDING_CALLS) {
      this.fail(id, new PageAppCapabilityError("resource_exhausted", "Too many calls in flight."));
      return;
    }
    this.outstanding += 1;
    try {
      const plugin = await this.gate(name);
      if (!plugin.call)
        throw new PageAppCapabilityError("invalid_argument", `"${name}" has no calls.`);
      const value = await plugin.call(this.context(plugin), method, args);
      this.send({ kind: "result", id, ok: true, value: value === undefined ? null : value });
    } catch (error) {
      this.fail(id, error);
    } finally {
      this.outstanding -= 1;
    }
  }

  private async handleWatch(id: number, name: string, method: string, args: unknown) {
    const end = (error?: PageAppCallError) => {
      if (!this.watches.has(id)) return;
      this.watches.delete(id);
      this.send(error ? { kind: "end", id, error } : { kind: "end", id });
    };
    if (this.watches.has(id)) return;
    if (this.watches.size >= PAGE_APP_DB_MAX_SUBSCRIPTIONS) {
      this.send({
        kind: "end",
        id,
        error: { code: "resource_exhausted", message: "Too many subscriptions on this page." },
      });
      return;
    }
    // Reserve the id before any await so an early unwatch finds it.
    let cancelled = false;
    this.watches.set(id, () => {
      cancelled = true;
    });
    try {
      const plugin = await this.gate(name);
      if (!plugin.watch)
        throw new PageAppCapabilityError("invalid_argument", `"${name}" has no subscriptions.`);
      if (cancelled || !this.watches.has(id)) return;
      const cancel = plugin.watch(this.context(plugin), method, args, {
        next: (value) => {
          if (this.watches.has(id)) this.send({ kind: "event", id, value });
        },
        end,
      });
      if (!this.watches.has(id)) cancel();
      else this.watches.set(id, cancel);
    } catch (error) {
      end(toPageAppCallError(error));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    for (const cancel of this.watches.values()) cancel();
    this.watches.clear();
  }
}
