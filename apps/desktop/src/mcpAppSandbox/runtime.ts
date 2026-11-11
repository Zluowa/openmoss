// FILE: runtime.ts
// Purpose: Electron integration for the isolated MCP App registry, port broker,
// webview admission, and session teardown. Content never enters this runtime.

import * as FS from "node:fs/promises";
import * as Path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessagePortMain,
  type Session,
  type WebContents,
} from "electron";
import {
  MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
  MCP_APP_SANDBOX_PENDING_TTL_MS,
  MCP_APP_SANDBOX_PORT_NAMES,
  MCP_APP_SANDBOX_SCHEME,
  decodeMcpAppSandboxDownloadInput,
  decodeMcpAppSandboxGuestInitEnvelope,
  normalizeMcpAppSandboxPermissions,
  type McpAppSandboxDescriptor,
  type McpAppSandboxPermissions,
} from "@moss/contracts";

import { MCP_APP_IPC_CHANNELS } from "../ipcChannels";
import { registerSentryIpcHandler } from "../observability/sentry";
import { normalizeMcpAppExternalUrl, sanitizeMcpAppDownloadFileName } from "./external";
import {
  decideMcpAppPermission,
  decideMcpAppPermissionCheck,
  grantableMcpAppPermissions,
  type McpAppPermissionContext,
} from "./permissions";
import { resolveMcpAppSandboxProtocolRequest } from "./protocol";
import { McpAppSandboxRegistry, type McpAppSandboxRegistration } from "./registry";
import {
  MCP_APP_DENY_DOWNLOADS,
  MCP_APP_DENY_POPUPS,
  hardenedMcpAppWebPreferences,
  isAllowedMcpAppNetworkUrl,
  isAllowedMcpAppSubframeUrl,
  isExactMcpAppSandboxUrl,
  isMcpAppSandboxPartition,
  normalizeMcpAppUserAgent,
} from "./policy";

interface PendingAttach {
  readonly ownerId: number;
  readonly registration: McpAppSandboxRegistration;
  readonly partitionSession: Session;
}

interface ActiveGuest {
  readonly ownerId: number;
  readonly registration: McpAppSandboxRegistration;
  readonly guest: WebContents;
  readonly partitionSession: Session;
  cleanup: () => void;
  guestInitialized: boolean;
  portForwarded: boolean;
}

interface PartitionPolicy {
  readonly session: Session;
  readonly requestHandler: (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void,
  ) => void;
  readonly downloadHandler: (event: Electron.Event) => void;
  count: number;
}

interface RegistrationTimer {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cardIdentityKey: string;
}

const MAX_REGISTERED_PARTITIONS = 128;

export interface McpAppSandboxRuntimeHooks {
  readonly onSecurityDenied?: (event: {
    readonly kind: "network" | "popup" | "download" | "permission";
    readonly url?: string;
  }) => void;
  /** Every device-permission decision (request or check) for a widget guest. */
  readonly onPermissionDecision?: (event: {
    readonly permission: string;
    readonly mediaTypes: readonly string[];
    readonly granted: boolean;
    readonly kind: "request" | "check";
  }) => void;
  /** Inter woff2 bytes for the sandbox asset origin; null when unavailable. */
  readonly loadFont?: () => Promise<Uint8Array | null>;
  /** System shell; replaced in tests. */
  readonly openExternal?: (url: string) => Promise<void>;
  /** Save dialog; replaced in tests. */
  readonly showSaveDialog?: (
    owner: BrowserWindow | null,
    options: Electron.SaveDialogOptions,
  ) => Promise<Electron.SaveDialogReturnValue>;
  readonly downloadsPath?: () => string;
}

function identityKey(
  ownerId: number,
  descriptor: Pick<McpAppSandboxDescriptor, "sandboxId" | "initId" | "generation">,
): string {
  return `${ownerId}:${descriptor.sandboxId}:${descriptor.initId}:${descriptor.generation}`;
}

function closePort(port: MessagePortMain | null | undefined): void {
  try {
    port?.close();
  } catch {
    // Teardown is idempotent even when Electron already closed the port.
  }
}

export class McpAppSandboxRuntime {
  readonly registry = new McpAppSandboxRegistry();
  private readonly hooks: McpAppSandboxRuntimeHooks;
  private readonly ownerIds = new Set<number>();
  private readonly ownerWebContents = new Map<number, WebContents>();
  private readonly pendingAttach = new Map<string, PendingAttach>();
  private readonly activeGuests = new Map<string, ActiveGuest>();
  private readonly pendingAttachTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly registrationTimers = new Map<string, RegistrationTimer>();
  private readonly partitionPolicies = new Map<string, PartitionPolicy>();
  private readonly registeredPartitions = new Map<string, Session>();
  /** Device permissions the trusted host granted, per partition (cleared with it). */
  private readonly partitionGrants = new Map<string, McpAppSandboxPermissions>();
  private fontBytes: Uint8Array | null = null;
  private ipcRegistered = false;

  constructor(hooks: McpAppSandboxRuntimeHooks = {}) {
    this.hooks = hooks;
  }

  register(ownerId: number, input: unknown) {
    if (!this.ownerIds.has(ownerId)) return null;
    try {
      const descriptor = this.registry.register(ownerId, input);
      const key = identityKey(ownerId, descriptor);
      const registration = this.registry.lookupByUrl(descriptor.src, {
        ownerId,
        partition: descriptor.partition,
      });
      if (!registration) {
        this.registry.unregister(ownerId, {
          sandboxId: descriptor.sandboxId,
          initId: descriptor.initId,
          generation: descriptor.generation,
        });
        return null;
      }
      this.clearRegistrationTimersForCard(ownerId, registration.cardIdentityKey, key);
      this.registry.replacePendingForOwnerCard(
        ownerId,
        registration.cardIdentityKey,
        registration.authorityKey,
      );
      for (const [activeKey, active] of this.activeGuests) {
        if (
          active.ownerId === ownerId &&
          active.registration.cardIdentityKey === registration.cardIdentityKey &&
          activeKey !== key
        ) {
          this.disposeActive(activeKey);
        }
      }
      for (const [pendingKey, pending] of this.pendingAttach) {
        if (
          pending.ownerId === ownerId &&
          pending.registration.cardIdentityKey === registration.cardIdentityKey &&
          pendingKey !== key
        ) {
          this.disposePendingAttach(pendingKey, pending);
        }
      }
      try {
        this.ensurePartitionProtocol(descriptor.partition);
      } catch {
        // A session that cannot install the dedicated route must not retain a
        // registration that can never attach. The source partition may still be
        // reused by a later valid registration if the session becomes usable.
        this.registry.unregister(ownerId, {
          sandboxId: descriptor.sandboxId,
          initId: descriptor.initId,
          generation: descriptor.generation,
        });
        this.releaseUnusedPartitionProtocols();
        return null;
      }
      this.registrationTimers.set(key, {
        cardIdentityKey: registration.cardIdentityKey,
        timer: setTimeout(() => {
          this.registrationTimers.delete(key);
          this.registry.unregister(ownerId, {
            sandboxId: descriptor.sandboxId,
            initId: descriptor.initId,
            generation: descriptor.generation,
          });
          this.releaseUnusedPartitionProtocols();
        }, MCP_APP_SANDBOX_PENDING_TTL_MS),
      });
      this.releaseUnusedPartitionProtocols();
      return descriptor;
    } catch {
      return null;
    }
  }

  unregister(ownerId: number, input: unknown): boolean {
    const candidate = input as Record<string, unknown>;
    const sandboxId = typeof candidate?.sandboxId === "string" ? candidate.sandboxId : null;
    const initId = typeof candidate?.initId === "string" ? candidate.initId : null;
    const generation = typeof candidate?.generation === "number" ? candidate.generation : null;
    const key =
      sandboxId && initId !== null && generation !== null
        ? `${ownerId}:${sandboxId}:${initId}:${generation}`
        : null;
    const active = key
      ? (() => {
          const value = this.activeGuests.get(key);
          return value && value.ownerId === ownerId ? value : undefined;
        })()
      : undefined;
    if (active) {
      this.disposeActive(key!);
      return true;
    }
    const pending = key ? this.pendingAttach.get(key) : undefined;
    if (pending && pending.ownerId === ownerId) {
      this.disposePendingAttach(key!, pending);
      return true;
    }
    const unregistered = this.registry.unregister(ownerId, input);
    if (unregistered) {
      this.clearRegistrationTimer(key!);
      this.releaseUnusedPartitionProtocols();
    }
    return unregistered;
  }

  attachOwner(window: BrowserWindow): void {
    const ownerId = window.webContents.id;
    this.ownerIds.add(ownerId);
    this.ownerWebContents.set(ownerId, window.webContents);
    window.webContents.once("destroyed", () => this.teardownOwner(ownerId));
  }

  teardownOwner(ownerId: number): void {
    this.ownerIds.delete(ownerId);
    this.ownerWebContents.delete(ownerId);
    for (const [key, active] of this.activeGuests) {
      if (active.ownerId === ownerId) this.disposeActive(key);
    }
    for (const [key, pending] of this.pendingAttach) {
      if (pending.ownerId === ownerId) this.disposePendingAttach(key, pending);
    }
    this.clearRegistrationTimersForOwner(ownerId);
    this.registry.teardownOwner(ownerId);
    this.releaseUnusedPartitionProtocols();
  }

  /** Returns true when the MCP branch claimed this webview admission attempt. */
  handleWillAttachWebview(
    ownerId: number,
    event: { preventDefault: () => void },
    webPreferences: object,
    params: { readonly partition?: string; readonly src?: string },
    preloadPath: string,
  ): boolean {
    const src = params.src;
    if (typeof src !== "string" || !src.startsWith(`${MCP_APP_SANDBOX_SCHEME}:`)) return false;
    const registration = this.registry.lookupByUrl(
      src,
      params.partition === undefined ? { ownerId } : { ownerId, partition: params.partition },
    );
    if (!registration) {
      event.preventDefault();
      return true;
    }
    const descriptor = registration.descriptor;
    let origin = "";
    try {
      const parsed = new URL(src);
      origin = `${parsed.protocol}//${parsed.host}`;
    } catch {
      event.preventDefault();
      return true;
    }
    const valid =
      typeof params.partition === "string" &&
      isMcpAppSandboxPartition(params.partition, descriptor.sandboxId) &&
      isExactMcpAppSandboxUrl(src, descriptor) &&
      origin === descriptor.origin;
    if (!valid) {
      event.preventDefault();
      return true;
    }
    const consumed = this.registry.consumeAttachment({
      ownerId,
      sandboxId: descriptor.sandboxId,
      initId: descriptor.initId,
      generation: descriptor.generation,
      partition: params.partition,
      src,
      origin,
    });
    if (!consumed) {
      event.preventDefault();
      return true;
    }
    this.clearRegistrationTimer(identityKey(ownerId, descriptor));
    const partitionSession = session.fromPartition(descriptor.partition);
    Object.assign(webPreferences, hardenedMcpAppWebPreferences(preloadPath), {
      // Electron's custom-scheme webview path requires the exact isolated
      // Session object. The renderer-provided partition remains an admission
      // input, never the session selected for the guest.
      session: partitionSession,
    });
    const key = identityKey(ownerId, descriptor);
    this.pendingAttach.set(key, {
      ownerId,
      registration: consumed,
      partitionSession,
    });
    this.pendingAttachTimers.set(
      key,
      setTimeout(() => {
        const pending = this.pendingAttach.get(key);
        if (pending) this.disposePendingAttach(key, pending);
      }, MCP_APP_SANDBOX_PENDING_TTL_MS),
    );
    return true;
  }

  handleDidAttachWebview(ownerId: number, guest: WebContents): boolean {
    let src = "";
    try {
      src = guest.getURL();
    } catch {
      // A renderer can be destroyed between did-attach and this callback. An
      // unknown URL is only claimable when its session is a registered MCP
      // partition; ordinary guests remain outside this runtime.
    }
    const guestSession = (guest as WebContents & { readonly session?: Session }).session;
    const isMcpScheme = src.startsWith(`${MCP_APP_SANDBOX_SCHEME}:`);
    const hasRegisteredMcpSession =
      [...this.pendingAttach.values()].some(
        (value) => value.ownerId === ownerId && value.partitionSession === guestSession,
      ) ||
      [...this.registeredPartitions.values()].some((registered) => registered === guestSession);
    if (!isMcpScheme && !hasRegisteredMcpSession) return false;
    const candidates = [...this.pendingAttach.entries()].filter(([, value]) => {
      if (value.ownerId !== ownerId) return false;
      // An empty URL is common during the first attach tick, but it is not a
      // license to guess across source partitions. Electron still exposes the
      // partition session, so require that stable identity in every case.
      if (!guestSession || guestSession !== value.partitionSession) return false;
      const descriptorSrc = value.registration.descriptor.src;
      const descriptorBase = descriptorSrc.split("#", 1)[0];
      // Electron can report an empty URL or omit the fragment immediately
      // after did-attach. Never guess when two authorities are candidates.
      return !src || src === descriptorSrc || src === descriptorBase;
    });
    if (candidates.length !== 1) {
      if (!guest.isDestroyed()) {
        try {
          guest.close({ waitForBeforeUnload: false });
        } catch {
          // A guest that cannot be associated is still not admitted to runtime state.
        }
      }
      return true;
    }
    const pending = candidates[0];
    if (!pending) return false;
    const [key, value] = pending;
    this.pendingAttach.delete(key);
    this.clearPendingAttachTimer(key);
    const active: ActiveGuest = {
      ownerId,
      registration: value.registration,
      guest,
      partitionSession: value.partitionSession,
      cleanup: () => undefined,
      guestInitialized: false,
      portForwarded: false,
    };
    this.activeGuests.set(key, active);
    active.cleanup = this.installGuestPolicy(key, active);
    return true;
  }

  /**
   * Grant exactly the approved device permissions to one partition. Only keys a
   * live registration of this owner there declared (and may delegate) count.
   */
  requestPermissions(
    ownerId: number,
    sandboxId: unknown,
    rawPermissions: unknown,
  ): { readonly granted: McpAppSandboxPermissions } {
    const denied = { granted: {} };
    if (!this.ownerIds.has(ownerId) || typeof sandboxId !== "string") return denied;
    const permissions = normalizeMcpAppSandboxPermissions(rawPermissions);
    if (!permissions) return denied;
    const partition = `moss-mcp-${sandboxId}`;
    if (!isMcpAppSandboxPartition(partition, sandboxId)) return denied;
    const registrations = this.registry
      .registrationsForPartition(partition)
      .filter((registration) => registration.ownerId === ownerId);
    if (registrations.length === 0) return denied;
    const granted = grantableMcpAppPermissions(
      permissions,
      registrations.map((registration) => registration.policy.permissions),
    );
    this.partitionGrants.set(partition, granted);
    return { granted };
  }

  async openExternal(ownerId: number, rawUrl: unknown): Promise<{ readonly opened: boolean }> {
    if (!this.ownerIds.has(ownerId)) return { opened: false };
    const url = normalizeMcpAppExternalUrl(rawUrl);
    if (!url) return { opened: false };
    try {
      await (this.hooks.openExternal ?? ((target: string) => shell.openExternal(target)))(url);
      return { opened: true };
    } catch {
      return { opened: false };
    }
  }

  async saveDownload(ownerId: number, rawInput: unknown): Promise<{ readonly saved: boolean }> {
    const owner = this.ownerWebContents.get(ownerId);
    if (!this.ownerIds.has(ownerId) || !owner || owner.isDestroyed()) return { saved: false };
    const payload = decodeMcpAppSandboxDownloadInput(rawInput);
    if (!payload) return { saved: false };
    const fileName = sanitizeMcpAppDownloadFileName(payload.fileName);
    const downloads = (this.hooks.downloadsPath ?? (() => app.getPath("downloads")))();
    const showSaveDialog =
      this.hooks.showSaveDialog ??
      ((window: BrowserWindow | null, options: Electron.SaveDialogOptions) =>
        window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
    try {
      const choice = await showSaveDialog(BrowserWindow.fromWebContents(owner), {
        defaultPath: Path.join(downloads, fileName),
      });
      if (choice.canceled || !choice.filePath) return { saved: false };
      await FS.writeFile(choice.filePath, payload.bytes);
      return { saved: true };
    } catch {
      return { saved: false };
    }
  }

  registerIpcHandlers(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;
    const { register, unregister, guestMessage, requestPermissions, openExternal, saveDownload } =
      MCP_APP_IPC_CHANNELS;
    ipcMain.removeHandler(requestPermissions);
    registerSentryIpcHandler(
      ipcMain,
      requestPermissions,
      (event: IpcMainInvokeEvent, sandboxId: unknown, permissions: unknown) =>
        this.requestPermissions(event.sender.id, sandboxId, permissions),
    );
    ipcMain.removeHandler(openExternal);
    registerSentryIpcHandler(ipcMain, openExternal, (event: IpcMainInvokeEvent, url: unknown) =>
      this.openExternal(event.sender.id, url),
    );
    ipcMain.removeHandler(saveDownload);
    registerSentryIpcHandler(ipcMain, saveDownload, (event: IpcMainInvokeEvent, input: unknown) =>
      this.saveDownload(event.sender.id, input),
    );
    ipcMain.removeHandler(register);
    registerSentryIpcHandler(ipcMain, register, (event, input: unknown) =>
      this.register(event.sender.id, input),
    );
    ipcMain.removeHandler(unregister);
    registerSentryIpcHandler(ipcMain, unregister, (event, input: unknown) =>
      this.unregister(event.sender.id, input),
    );
    ipcMain.removeAllListeners(guestMessage);
    ipcMain.on(guestMessage, (event: IpcMainEvent, payload: unknown) => {
      this.handleGuestPortMessage(event, payload);
    });
  }

  registerProtocol(): void {
    // The custom handler must be registered on each source partition. The
    // default session handler is intentionally never used for MCP guests.
  }

  private ensurePartitionProtocol(partition: string): void {
    if (this.registeredPartitions.has(partition)) return;
    if (this.registeredPartitions.size >= MAX_REGISTERED_PARTITIONS) {
      throw new Error("MCP App partition limit reached.");
    }
    const partitionSession = session.fromPartition(partition);
    partitionSession.protocol.handle(MCP_APP_SANDBOX_SCHEME, async (request) => {
      const response = resolveMcpAppSandboxProtocolRequest(
        request.url,
        this.registry,
        partition,
        request.method,
      );
      if (!response) {
        return new Response("Not found", { status: 404 });
      }
      if (response.kind === "font") {
        const bytes = await this.loadFontBytes();
        if (!bytes) return new Response("Not found", { status: 404 });
        return new Response(new Uint8Array(bytes), {
          headers: response.headers,
          status: response.statusCode,
        });
      }
      return new Response(response.data, {
        headers: response.headers,
        status: response.statusCode,
      });
    });
    this.registeredPartitions.set(partition, partitionSession);
  }

  private async loadFontBytes(): Promise<Uint8Array | null> {
    // Only a successful read is cached, so a failed read can be retried.
    if (this.fontBytes) return this.fontBytes;
    const loadFont = this.hooks.loadFont;
    if (!loadFont) return null;
    const bytes = await loadFont().catch(() => null);
    if (bytes) this.fontBytes = bytes;
    return bytes;
  }

  private permissionContextFor(
    webContents: WebContents | null,
    partition: string,
  ): McpAppPermissionContext | null {
    if (!webContents) return null;
    const active = [...this.activeGuests.values()].find(
      (candidate) =>
        candidate.guest.id === webContents.id &&
        candidate.registration.descriptor.partition === partition,
    );
    if (!active) return null;
    return {
      declared: active.registration.policy.permissions,
      granted: this.partitionGrants.get(partition) ?? {},
    };
  }

  private clearPendingAttachTimer(key: string): void {
    const timer = this.pendingAttachTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingAttachTimers.delete(key);
  }

  private clearRegistrationTimer(key: string): void {
    const registration = this.registrationTimers.get(key);
    if (!registration) return;
    clearTimeout(registration.timer);
    this.registrationTimers.delete(key);
  }

  private clearRegistrationTimersForCard(
    ownerId: number,
    cardIdentityKey: string,
    exceptKey: string,
  ): void {
    for (const [key, registration] of this.registrationTimers) {
      if (
        key.startsWith(`${ownerId}:`) &&
        registration.cardIdentityKey === cardIdentityKey &&
        key !== exceptKey
      ) {
        this.clearRegistrationTimer(key);
      }
    }
  }

  private clearRegistrationTimersForOwner(ownerId: number): void {
    for (const key of this.registrationTimers.keys()) {
      if (key.startsWith(`${ownerId}:`)) this.clearRegistrationTimer(key);
    }
  }

  private disposePendingAttach(key: string, pending: PendingAttach): void {
    this.pendingAttach.delete(key);
    this.clearPendingAttachTimer(key);
    this.registry.releaseAttachment(pending.ownerId, {
      sandboxId: pending.registration.descriptor.sandboxId,
      initId: pending.registration.descriptor.initId,
      generation: pending.registration.descriptor.generation,
    });
    this.releaseUnusedPartitionProtocols();
  }

  private releaseUnusedPartitionProtocols(): void {
    for (const [partition, partitionSession] of this.registeredPartitions) {
      if (this.registry.hasPartition(partition)) continue;
      this.partitionGrants.delete(partition);
      try {
        partitionSession.protocol.unhandle(MCP_APP_SANDBOX_SCHEME);
      } catch {
        // The session may already be shutting down. The registry is still clear.
      }
      this.registeredPartitions.delete(partition);
    }
  }

  private handleGuestPortMessage(event: IpcMainEvent, payload: unknown): void {
    const guestEnvelope = decodeMcpAppSandboxGuestInitEnvelope(payload);
    if (
      !guestEnvelope ||
      event.ports.length !== guestEnvelope.portNames.length + 1 ||
      guestEnvelope.portNames.length !== MCP_APP_SANDBOX_PORT_NAMES.length ||
      guestEnvelope.portNames.some((name, index) => name !== MCP_APP_SANDBOX_PORT_NAMES[index])
    ) {
      for (const port of event.ports) closePort(port);
      return;
    }
    const activeEntry = [...this.activeGuests.entries()].find(
      ([, value]) => value.guest.id === event.sender.id,
    );
    if (!activeEntry) {
      for (const port of event.ports) closePort(port);
      return;
    }
    const [key, active] = activeEntry;
    const descriptor = active.registration.descriptor;
    const currentUrl = active.guest.getURL();
    const baseUrl = descriptor.src.split("#", 1)[0];
    const valid =
      active.ownerId === this.ownerWebContents.get(active.ownerId)?.id &&
      event.sender === active.guest &&
      guestEnvelope.origin === descriptor.origin &&
      guestEnvelope.initId === descriptor.initId &&
      (currentUrl === "" || currentUrl === descriptor.src || currentUrl === baseUrl) &&
      (active.guest as WebContents & { readonly session?: Session }).session ===
        active.partitionSession &&
      !active.guestInitialized &&
      !active.portForwarded;
    if (!valid) {
      for (const port of event.ports) closePort(port);
      return;
    }
    const owner = this.ownerWebContents.get(active.ownerId);
    if (!owner || owner.isDestroyed()) {
      for (const port of event.ports) closePort(port);
      this.disposeActive(key);
      return;
    }
    active.guestInitialized = true;
    active.portForwarded = true;
    const envelope = {
      type: MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
      origin: descriptor.origin,
      sandboxId: descriptor.sandboxId,
      initId: descriptor.initId,
      portNames: [...MCP_APP_SANDBOX_PORT_NAMES],
    };
    try {
      owner.postMessage(MCP_APP_IPC_CHANNELS.trustedMessage, envelope, [...event.ports]);
    } catch {
      for (const port of event.ports) closePort(port);
      this.disposeActive(key);
    }
  }

  private installGuestPolicy(key: string, active: ActiveGuest): () => void {
    const { guest } = active;
    const { descriptor, policy } = active.registration;
    const expectedSrc = descriptor.src;
    const navigationHandler = (event: Electron.Event, url: string) => {
      if (url !== expectedSrc) event.preventDefault();
    };
    const redirectHandler = (event: Electron.Event) => event.preventDefault();
    const frameNavigationHandler = (details: Electron.Event & { readonly url?: string }) => {
      const url = details.url;
      if (!url) {
        details.preventDefault();
        return;
      }
      const isMainFrame = (details as Electron.Event & { readonly isMainFrame?: boolean })
        .isMainFrame;
      if (isMainFrame !== false) {
        if (url !== expectedSrc) details.preventDefault();
        return;
      }
      // The widget frame is srcdoc (isolated) or about:blank (stable). It and
      // its own sub-frames may only go to blank/data/blob documents, which
      // inherit the proxy's policy, or to an allowed frame site.
      if (!isAllowedMcpAppSubframeUrl(url, policy)) {
        this.hooks.onSecurityDenied?.({ kind: "network", url });
        details.preventDefault();
      }
    };
    const windowOpenHandler = (details: { readonly url?: string }) => {
      if (MCP_APP_DENY_POPUPS) {
        this.hooks.onSecurityDenied?.({
          kind: "popup",
          ...(details.url !== undefined ? { url: details.url } : {}),
        });
      }
      return { action: MCP_APP_DENY_POPUPS ? ("deny" as const) : ("allow" as const) };
    };
    const releasePartitionPolicy = this.acquirePartitionPolicy(active.registration);
    // WebRTC traffic bypasses webRequest; never let it leave without a proxy.
    try {
      guest.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    } catch {
      // Older guests without the setting still get the proxy page's CSP.
    }
    guest.on("will-navigate", navigationHandler);
    guest.on("will-redirect", redirectHandler);
    guest.on("will-frame-navigate", frameNavigationHandler);
    guest.setWindowOpenHandler(windowOpenHandler);
    // Permission handlers are session-wide; the partition policy installs one
    // denying handler and keeps it until the final guest in this partition is gone.
    const onDestroyed = () => this.disposeActive(key);
    const onGone = () => this.disposeActive(key);
    const onFailedLoad = (
      _event: Electron.Event,
      _errorCode: number,
      _errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) this.disposeActive(key);
    };
    const onPreloadError = (_event: Electron.Event, _preloadPath: string, _error: Error) =>
      this.disposeActive(key);
    const onNavigateInPage = (_event: Electron.Event, url: string, isMainFrame: boolean) => {
      if (isMainFrame && url !== expectedSrc) this.disposeActive(key);
    };
    guest.once("destroyed", onDestroyed);
    guest.once("render-process-gone", onGone);
    guest.on("did-fail-load", onFailedLoad);
    guest.on("preload-error", onPreloadError);
    guest.on("did-navigate-in-page", onNavigateInPage);
    return () => {
      guest.removeListener("will-navigate", navigationHandler);
      guest.removeListener("will-redirect", redirectHandler);
      guest.removeListener("will-frame-navigate", frameNavigationHandler);
      guest.removeListener("destroyed", onDestroyed);
      guest.removeListener("render-process-gone", onGone);
      guest.removeListener("did-fail-load", onFailedLoad);
      guest.removeListener("preload-error", onPreloadError);
      guest.removeListener("did-navigate-in-page", onNavigateInPage);
      releasePartitionPolicy();
    };
  }

  private acquirePartitionPolicy(registration: McpAppSandboxRegistration): () => void {
    const partition = registration.descriptor.partition;
    const existing = this.partitionPolicies.get(partition);
    if (existing) {
      existing.count += 1;
      return () => this.releasePartitionPolicy(partition);
    }
    const partitionSession = session.fromPartition(partition);
    const downloadHandler = (event: Electron.Event) => {
      if (MCP_APP_DENY_DOWNLOADS) {
        event.preventDefault();
        this.hooks.onSecurityDenied?.({ kind: "download" });
      }
    };
    const requestHandler = (
      details: Electron.OnBeforeRequestListenerDetails,
      callback: (response: Electron.CallbackResponse) => void,
    ) => {
      const active = [...this.activeGuests.values()].find(
        (candidate) => candidate.guest.id === details.webContentsId,
      );
      if (!active) {
        callback({ cancel: true });
        return;
      }
      const descriptor = active.registration.descriptor;
      const policy = active.registration.policy;
      const resourceType = String(details.resourceType).toLowerCase();
      const expectedBase = descriptor.src.split("#", 1)[0];
      // Electron 43 includes the fragment for the initial custom-scheme
      // request, while newer builds commonly omit it at the network layer.
      // Network admission is therefore keyed to the fixed base route; the
      // exact fragment authority is revalidated by will-attach/preload and
      // same-document navigation handlers.
      const requestBase = details.url.split("#", 1)[0];
      const allowed =
        resourceType === "mainframe"
          ? requestBase === expectedBase
          : resourceType === "subframe"
            ? isAllowedMcpAppSubframeUrl(details.url, policy)
            : resourceType === "xhr" || resourceType === "fetch" || resourceType === "websocket"
              ? isAllowedMcpAppNetworkUrl(details.url, "connect-src", policy)
              : isAllowedMcpAppNetworkUrl(details.url, "resource", policy);
      if (!allowed) {
        this.hooks.onSecurityDenied?.({ kind: "network", url: details.url });
      }
      callback({ cancel: !allowed });
    };
    // Device permissions: only what the widget declared, the host granted for
    // this partition, and no frame site withholds. Everything else is denied.
    partitionSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const mediaTypes = [
        ...(((details as { readonly mediaTypes?: readonly string[] } | undefined)?.mediaTypes ??
          []) as readonly string[]),
      ];
      const granted = decideMcpAppPermission(
        String(permission),
        permission === "media" ? mediaTypes : undefined,
        this.permissionContextFor(webContents, partition),
      );
      this.hooks.onPermissionDecision?.({
        permission: String(permission),
        mediaTypes,
        granted,
        kind: "request",
      });
      if (!granted) {
        this.hooks.onSecurityDenied?.({ kind: "permission", url: String(permission) });
      }
      callback(granted);
    });
    partitionSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
      const mediaType = (details as { readonly mediaType?: string } | undefined)?.mediaType;
      const granted = decideMcpAppPermissionCheck(
        String(permission),
        mediaType,
        this.permissionContextFor(webContents, partition),
      );
      this.hooks.onPermissionDecision?.({
        permission: String(permission),
        mediaTypes: mediaType ? [mediaType] : [],
        granted,
        kind: "check",
      });
      return granted;
    });
    partitionSession.setDevicePermissionHandler(() => false);
    partitionSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    partitionSession.on("will-download", downloadHandler);
    partitionSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, requestHandler);
    partitionSession.setUserAgent(normalizeMcpAppUserAgent(partitionSession.getUserAgent()));
    this.partitionPolicies.set(partition, {
      count: 1,
      downloadHandler,
      requestHandler,
      session: partitionSession,
    });
    return () => this.releasePartitionPolicy(partition);
  }

  private releasePartitionPolicy(partition: string): void {
    const policy = this.partitionPolicies.get(partition);
    if (!policy) return;
    policy.count -= 1;
    if (policy.count > 0) return;
    policy.session.removeListener("will-download", policy.downloadHandler);
    policy.session.webRequest.onBeforeRequest(null);
    policy.session.setPermissionRequestHandler(null);
    policy.session.setPermissionCheckHandler(null);
    policy.session.setDevicePermissionHandler(null);
    policy.session.setDisplayMediaRequestHandler(null);
    this.partitionPolicies.delete(partition);
  }

  private disposeActive(key: string): void {
    const active = this.activeGuests.get(key);
    if (!active) return;
    this.activeGuests.delete(key);
    try {
      active.cleanup();
    } catch {
      // Continue cleanup even when a session/listener teardown throws.
    }
    try {
      this.registry.releaseAttachment(active.ownerId, {
        sandboxId: active.registration.descriptor.sandboxId,
        initId: active.registration.descriptor.initId,
        generation: active.registration.descriptor.generation,
      });
    } catch {
      // The exact authority is still removed from the in-memory route below.
    }
    try {
      if (!active.guest.isDestroyed()) {
        active.guest.close({ waitForBeforeUnload: false });
      }
    } catch {
      // Guest teardown is best effort after the policy is detached.
    }
    this.releaseUnusedPartitionProtocols();
  }
}
