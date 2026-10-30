// FILE: connectorOAuthCallback.ts
// Purpose: Validates and queues one-shot connector OAuth deep links in desktop memory.
// Layer: Desktop main/preload shared logic
// Depends on: The desktop OAuth callback IPC contract only.

import type { DesktopConnectorOAuthCallback } from "@synara/contracts";
import {
  MOSS_AUTH_PROTOCOL_REGISTRATION_DISABLED_ENV,
  MOSS_CONNECTOR_OAUTH_SCHEME,
} from "@synara/shared/desktopIdentity";

export const CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS = {
  subscribe: "desktop:connector-oauth-callback-subscribe",
  unsubscribe: "desktop:connector-oauth-callback-unsubscribe",
  event: "desktop:connector-oauth-callback",
} as const;

const CALLBACK_HOST = "connector";
const CALLBACK_PATHNAME = "/oauth_callback";
const FULL_REDIRECT_URL_PARAMETER = "fullRedirectUrl";
const RETURN_TO_PARAMETER = "returnTo";
const ALLOWED_PARAMETERS = new Set([FULL_REDIRECT_URL_PARAMETER, RETURN_TO_PARAMETER]);
const MAX_CALLBACK_URL_LENGTH = 32 * 1024;
const MAX_FULL_REDIRECT_URL_LENGTH = 16 * 1024;
const MAX_RETURN_TO_LENGTH = 2 * 1024;
const MAX_PENDING_CALLBACKS = 64;
const MAX_CONSUMED_CALLBACKS = 256;

function hasSafeHttpProtocol(rawUrl: string): boolean {
  if (rawUrl.length === 0 || rawUrl.length > MAX_FULL_REDIRECT_URL_LENGTH) {
    return false;
  }

  try {
    const url = new URL(rawUrl);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function isSafeReturnTo(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_RETURN_TO_LENGTH &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

export function isDesktopConnectorOAuthCallback(
  value: unknown,
): value is DesktopConnectorOAuthCallback {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !keys.includes(FULL_REDIRECT_URL_PARAMETER) ||
    !keys.includes(RETURN_TO_PARAMETER)
  ) {
    return false;
  }

  return (
    typeof record.fullRedirectUrl === "string" &&
    hasSafeHttpProtocol(record.fullRedirectUrl) &&
    (record.returnTo === null ||
      (typeof record.returnTo === "string" && isSafeReturnTo(record.returnTo)))
  );
}

/**
 * Parse the dedicated callback URL without normalizing the nested redirect.
 * The nested URL contains the provider's opaque account/state/code payload and
 * must reach the renderer byte-for-byte; this module never stores it on disk.
 */
export function parseConnectorOAuthCallbackUrl(
  rawUrl: string,
): DesktopConnectorOAuthCallback | null {
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_CALLBACK_URL_LENGTH ||
    rawUrl.trim() !== rawUrl
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (
    url.protocol !== `${MOSS_CONNECTOR_OAUTH_SCHEME}:` ||
    url.hostname !== CALLBACK_HOST ||
    url.port.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== CALLBACK_PATHNAME ||
    url.hash.length > 0
  ) {
    return null;
  }

  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) {
      return null;
    }
  }

  const fullRedirectUrls = url.searchParams.getAll(FULL_REDIRECT_URL_PARAMETER);
  const returnTos = url.searchParams.getAll(RETURN_TO_PARAMETER);
  if (fullRedirectUrls.length !== 1 || returnTos.length > 1) {
    return null;
  }

  const fullRedirectUrl = fullRedirectUrls[0] ?? "";
  const returnTo = returnTos[0] ?? null;
  const callback = { fullRedirectUrl, returnTo };
  return isDesktopConnectorOAuthCallback(callback) ? callback : null;
}

interface PendingCallback {
  readonly callback: DesktopConnectorOAuthCallback;
  readonly fingerprint: string;
}

function callbackFingerprint(callback: DesktopConnectorOAuthCallback): string {
  return `${callback.fullRedirectUrl}\u0000${callback.returnTo ?? ""}`;
}

/** Process-lifetime, bounded, non-persistent one-shot callback inbox. */
export class ConnectorOAuthCallbackInbox {
  readonly #pending: PendingCallback[] = [];
  readonly #pendingFingerprints = new Set<string>();
  readonly #consumedFingerprints = new Set<string>();
  readonly #consumedOrder: string[] = [];

  get pendingCount(): number {
    return this.#pending.length;
  }

  enqueueUrl(rawUrl: string): boolean {
    const callback = parseConnectorOAuthCallbackUrl(rawUrl);
    if (!callback || this.#pending.length >= MAX_PENDING_CALLBACKS) {
      return false;
    }

    const fingerprint = callbackFingerprint(callback);
    if (this.#pendingFingerprints.has(fingerprint) || this.#consumedFingerprints.has(fingerprint)) {
      return false;
    }

    this.#pending.push({ callback, fingerprint });
    this.#pendingFingerprints.add(fingerprint);
    return true;
  }

  enqueueArgv(argv: ReadonlyArray<string>): number {
    let accepted = 0;
    for (const argument of argv) {
      if (this.enqueueUrl(argument)) {
        accepted += 1;
      }
    }
    return accepted;
  }

  /**
   * Deliver in FIFO order. A false return keeps the current callback queued so
   * a renderer reload can subscribe and receive it later.
   */
  drain(deliver: (callback: DesktopConnectorOAuthCallback) => boolean): number {
    let delivered = 0;
    while (this.#pending.length > 0) {
      const next = this.#pending[0];
      if (!next || !deliver(next.callback)) {
        break;
      }

      this.#pending.shift();
      this.#pendingFingerprints.delete(next.fingerprint);
      this.#rememberConsumed(next.fingerprint);
      delivered += 1;
    }
    return delivered;
  }

  #rememberConsumed(fingerprint: string): void {
    this.#consumedFingerprints.add(fingerprint);
    this.#consumedOrder.push(fingerprint);
    while (this.#consumedOrder.length > MAX_CONSUMED_CALLBACKS) {
      const expired = this.#consumedOrder.shift();
      if (expired) {
        this.#consumedFingerprints.delete(expired);
      }
    }
  }
}

export interface ConnectorOAuthCallbackAppEvents {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface ConnectorOAuthCallbackAppEventRegistration {
  readonly initialAcceptedCount: number;
  readonly dispose: () => void;
}

/**
 * Register both operating-system delivery paths before Electron becomes ready.
 * macOS emits open-url; Windows/Linux relaunch the registered app and pass the
 * URL through argv to the single-instance owner.
 */
export function installConnectorOAuthCallbackAppEvents(input: {
  readonly app: ConnectorOAuthCallbackAppEvents;
  readonly inbox: ConnectorOAuthCallbackInbox;
  readonly initialArgv: ReadonlyArray<string>;
  readonly onCallbackAccepted: () => void;
}): ConnectorOAuthCallbackAppEventRegistration {
  const initialAcceptedCount = input.inbox.enqueueArgv(input.initialArgv);
  const handleOpenUrl = (event: unknown, rawUrl: unknown): void => {
    if (typeof rawUrl !== "string" || !input.inbox.enqueueUrl(rawUrl)) {
      return;
    }
    if (
      typeof event === "object" &&
      event !== null &&
      "preventDefault" in event &&
      typeof event.preventDefault === "function"
    ) {
      event.preventDefault();
    }
    input.onCallbackAccepted();
  };
  const handleSecondInstance = (_event: unknown, argv: unknown): void => {
    if (!Array.isArray(argv) || !argv.every((value) => typeof value === "string")) {
      return;
    }
    if (input.inbox.enqueueArgv(argv) > 0) {
      input.onCallbackAccepted();
    }
  };

  input.app.on("open-url", handleOpenUrl);
  input.app.on("second-instance", handleSecondInstance);

  let disposed = false;
  return {
    initialAcceptedCount,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      input.app.removeListener("open-url", handleOpenUrl);
      input.app.removeListener("second-instance", handleSecondInstance);
    },
  };
}

export interface ConnectorOAuthProtocolClient {
  readonly isPackaged: boolean;
  setAsDefaultProtocolClient(scheme: string): boolean;
}

export type ConnectorOAuthProtocolRegistrationStatus = "skipped" | "registered" | "failed";

export function registerConnectorOAuthProtocolClient(
  app: ConnectorOAuthProtocolClient,
): ConnectorOAuthProtocolRegistrationStatus {
  // Isolated packaged checks must not replace either global OAuth handler.
  // Share the login protocol's explicit opt-out; normal installs still register.
  if (!app.isPackaged || process.env[MOSS_AUTH_PROTOCOL_REGISTRATION_DISABLED_ENV] === "1") {
    return "skipped";
  }

  try {
    return app.setAsDefaultProtocolClient(MOSS_CONNECTOR_OAUTH_SCHEME) ? "registered" : "failed";
  } catch {
    return "failed";
  }
}
