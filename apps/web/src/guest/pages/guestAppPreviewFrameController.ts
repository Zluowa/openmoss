// Single-use form navigation. Secrets live only in this opening operation, never React state.
import {
  PAGE_APP_PREVIEW_LIMITS,
  type PageGuestAppPreviewBrokerResult,
  type PageGuestAppReference,
  type PageGuestViewRequest,
} from "@moss/contracts";
import {
  READONLY_APP_ITEM_PROTOCOL,
  READONLY_APP_ITEM_TIMEOUT_MS,
} from "@moss/shared/readonlyAppItem";
import type { ReadonlyAppItemFrameStatus } from "~/components/spaceTypes/app/readonlyAppItemFrameController";
import { guestAppPreviewOrigin } from "./guestAppPreviewAvailability";
import type { GuestAppPreviewTransport } from "./guestAppPreviewTransport";

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");

export function createGuestAppPreviewFrameController(options: {
  readonly element: HTMLIFrameElement;
  readonly nonce?: string;
  readonly broker?: boolean;
  readonly shareId: string;
  readonly contentOrigin: string;
  readonly request: PageGuestViewRequest & {
    readonly pageId: NonNullable<PageGuestViewRequest["pageId"]>;
    readonly expectedPageRevision: number;
    readonly reference?: PageGuestAppReference;
  };
  readonly transport: GuestAppPreviewTransport;
  readonly onStatus: (status: ReadonlyAppItemFrameStatus) => void;
}) {
  const nonce = options.nonce ?? crypto.randomUUID();
  const frameName = `moss-app-preview-${nonce}`;
  const abort = new AbortController();
  let disposed = false;
  let submitted = false;
  let expiresAt = Number.POSITIVE_INFINITY;
  let secret = "";
  let brokerSecret = "",
    handle = "",
    brokerSource: PageGuestAppPreviewBrokerResult["source"] | undefined;
  let frameReady = false,
    checking = false,
    lastChecked = -Infinity,
    announced = false;
  let pendingFrameRequest: number | undefined,
    lastFrameId = 0;
  let frameCalls: number[] = [];
  // An opaque sandbox requires "*"; the payload is only a boolean acknowledgement to this exact frame.
  const reply = (kind: string, fields: { id?: number; ok?: boolean } = {}) =>
    options.element.contentWindow?.postMessage(
      { protocol: READONLY_APP_ITEM_PROTOCOL, nonce, kind, ...fields },
      "*",
    );
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    secret = "";
    brokerSecret = "";
    handle = "";
    brokerSource = undefined;
    clearTimeout(pollTimer);
    clearTimeout(checkTimer);
    clearTimeout(handshakeTimer);
    clearTimeout(expiryTimer);
    window.removeEventListener("message", receive);
    window.removeEventListener("pageshow", checkExpiry);
    window.removeEventListener("focus", checkExpiry);
    document.removeEventListener("visibilitychange", checkExpiry);
    if (options.element.name === frameName) {
      options.element.src = "about:blank";
      options.element.removeAttribute("name");
    }
  };
  const end = (status: ReadonlyAppItemFrameStatus) => {
    if (!disposed) {
      dispose();
      options.onStatus(status);
    }
  };
  const checkBroker = async (forFrame = false) => {
    if (disposed || !frameReady || !brokerSource || checking || !options.transport.inspect) return;
    if (Date.now() >= expiresAt) {
      end("expired");
      return;
    }
    if (!forFrame && performance.now() - lastChecked < 1_000) return;
    checking = true;
    lastChecked = performance.now();
    clearTimeout(pollTimer);
    checkTimer = setTimeout(() => end("timeout"), PAGE_APP_PREVIEW_LIMITS.operationMs);
    try {
      const result = await options.transport.inspect(
        { method: "permissions.state", handle, secret: brokerSecret, frameNonce: nonce },
        abort.signal,
      );
      if (disposed) return;
      if (Date.now() >= expiresAt) {
        end("expired");
        return;
      }
      if (!result.ok || !brokerSource) {
        end("unavailable");
        return;
      }
      if (Date.parse(result.value.expiresAt) !== expiresAt) {
        end("invalid");
        return;
      }
      const actual = result.value.source,
        expected = brokerSource;
      if (
        actual.sourceKind !== expected.sourceKind ||
        actual.publicationId !== expected.publicationId ||
        actual.generation !== expected.generation ||
        actual.pageId !== expected.pageId ||
        actual.pageRevision !== expected.pageRevision ||
        actual.appId !== expected.appId ||
        actual.appRevision !== expected.appRevision ||
        result.value.availableCapabilities.length !== 0
      ) {
        end("invalid");
        return;
      }
      options.onStatus("ready");
      if (!announced) {
        announced = true;
        reply("permissions-ready");
      }
      if (pendingFrameRequest !== undefined) {
        reply("permissions-state-result", { id: pendingFrameRequest, ok: true });
        pendingFrameRequest = undefined;
      }
      pollTimer = setTimeout(() => {
        void checkBroker();
      }, 10_000);
    } catch {
      end("invalid");
    } finally {
      checking = false;
      clearTimeout(checkTimer);
    }
  };
  const checkExpiry = () => {
    if (disposed) return;
    if (Date.now() >= expiresAt) end("expired");
    else if (document.visibilityState !== "hidden") void checkBroker();
  };
  const receive = (event: MessageEvent) => {
    if (Date.now() >= expiresAt) end("expired");
    if (
      disposed ||
      !submitted ||
      event.source !== options.element.contentWindow ||
      event.origin !== "null"
    )
      return;
    const message = event.data;
    if (message?.protocol !== READONLY_APP_ITEM_PROTOCOL || message.nonce !== nonce) return;
    if (message.kind === "permissions-state") {
      const id = message.id;
      if (
        !brokerSource ||
        !announced ||
        !Number.isSafeInteger(id) ||
        id <= lastFrameId ||
        id > 0x7fffffff
      )
        return;
      lastFrameId = id;
      const now = performance.now();
      frameCalls = frameCalls.filter((time) => now - time < 60_000);
      if (pendingFrameRequest !== undefined || frameCalls.length >= 5) {
        reply("permissions-state-result", { id, ok: false });
        return;
      }
      frameCalls.push(now);
      pendingFrameRequest = id;
      if (!checking) void checkBroker(true);
      return;
    }
    if (message.kind !== "loaded" || frameReady) return;
    clearTimeout(handshakeTimer);
    if (!brokerSource) window.removeEventListener("message", receive);
    frameReady = true;
    if (brokerSource) void checkBroker();
    else options.onStatus("ready");
  };
  const run = async () => {
    try {
      secret = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const hash = base64Url(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))),
      );
      if (disposed) return;
      let brokerSecretHash: string | undefined;
      if (options.broker && options.request.reference) {
        if (!options.transport.inspect) {
          end("invalid");
          return;
        }
        brokerSecret = base64Url(crypto.getRandomValues(new Uint8Array(32)));
        brokerSecretHash = base64Url(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(brokerSecret)),
          ),
        );
        if (disposed) return;
      }
      const result = await options.transport.open(
        {
          ...options.request,
          frameSecretHash: hash,
          frameNonce: nonce,
          ...(brokerSecretHash ? { brokerSecretHash } : {}),
        },
        abort.signal,
      );
      if (disposed) return;
      if (!result.ok) {
        end("invalid");
        return;
      }
      const receipt = result.value;
      const now = Date.now();
      const ticketExpires = Date.parse(receipt.ticketExpiresAt);
      expiresAt = Date.parse(receipt.frameExpiresAt);
      if (
        !Number.isFinite(ticketExpires) ||
        ticketExpires <= now ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now ||
        expiresAt - now > PAGE_APP_PREVIEW_LIMITS.frameMs
      ) {
        end("expired");
        return;
      }
      const source = receipt.source,
        ref = options.request.reference;
      const correctSource = ref
        ? source.sourceKind === "page-app" &&
          source.appId === ref.appId &&
          (ref.appRevision === undefined || source.appRevision === ref.appRevision) &&
          source.generation > 0 &&
          !!source.publicationId &&
          receipt.publicMetadata.revision === source.appRevision
        : source.sourceKind === "page-item" &&
          source.dataRevision <= source.pageRevision &&
          receipt.publicMetadata.revision === options.request.expectedPageRevision;
      if (
        !correctSource ||
        source.pageId !== options.request.pageId ||
        source.pageRevision !== options.request.expectedPageRevision ||
        !/^[A-Za-z0-9_-]{43}$/u.test(receipt.ticket)
      ) {
        end("invalid");
        return;
      }
      if (brokerSecretHash) {
        if (
          source.sourceKind !== "page-app" ||
          !receipt.brokerHandle ||
          !/^[A-Za-z0-9_-]{43}$/u.test(receipt.brokerHandle)
        ) {
          end("invalid");
          return;
        }
        handle = receipt.brokerHandle;
        brokerSource = source;
      }
      clearTimeout(handshakeTimer);
      handshakeTimer = setTimeout(() => end("timeout"), READONLY_APP_ITEM_TIMEOUT_MS);
      expiryTimer = setTimeout(() => end("expired"), expiresAt - now);
      const form = document.createElement("form");
      form.method = "POST";
      form.action = `${options.contentOrigin}/v1/app-previews/${options.shareId}/document`;
      form.target = frameName;
      form.enctype = "application/x-www-form-urlencoded";
      form.hidden = true;
      for (const [name, value] of [
        ["ticket", receipt.ticket],
        ["frameSecret", secret],
      ]) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name!;
        input.value = value!;
        form.append(input);
      }
      document.body.append(form);
      try {
        submitted = true;
        // Native submission serializes the two fields synchronously; nothing is retained in DOM.
        HTMLFormElement.prototype.submit.call(form);
      } finally {
        for (const input of Array.from(form.elements))
          if (input instanceof HTMLInputElement) input.value = "";
        form.remove();
        secret = "";
      }
    } catch {
      end("invalid");
    }
  };
  const capability = { protocolVersion: 1 as const, contentOrigin: options.contentOrigin };
  if (
    !/^[A-Za-z0-9_-]{16,64}$/u.test(nonce) ||
    !/^[A-Za-z0-9_-]{22}$/u.test(options.shareId) ||
    !guestAppPreviewOrigin(capability, capability, [options.contentOrigin], window.location.origin)
  ) {
    options.onStatus("invalid");
    return { dispose };
  }
  options.element.name = frameName;
  options.onStatus("loading");
  window.addEventListener("message", receive);
  window.addEventListener("pageshow", checkExpiry);
  window.addEventListener("focus", checkExpiry);
  document.addEventListener("visibilitychange", checkExpiry);
  handshakeTimer = setTimeout(() => end("timeout"), PAGE_APP_PREVIEW_LIMITS.operationMs);
  void run();
  return { dispose };
}
