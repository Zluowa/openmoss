// FILE: pluginDeepLink.ts
// Purpose: Validates Moss plugin deep links and owns their bounded, retryable navigation queue.
// Layer: Desktop main/preload shared logic

import type {
  DesktopPluginDeepLinkAudit,
  DesktopPluginDeepLinkNavigation,
  DesktopPluginDeepLinkNavigationResult,
  DesktopPluginDeepLinkRoute,
  DesktopPluginDeepLinkSource,
} from "@synara/contracts";
import { MOSS_CANARY_DESKTOP_SCHEME, MOSS_DESKTOP_SCHEME } from "@synara/shared/desktopIdentity";

const PLUGIN_DEEP_LINK_HOST = "plugins";
const PLUGIN_DEEP_LINK_ROUTE_PREFIX = "/skills/plugins/";
const MAX_PLUGIN_DEEP_LINK_URL_LENGTH = 8_192;
const MAX_PLUGIN_ID_LENGTH = 1_024;
const MAX_PENDING_PLUGIN_DEEP_LINKS = 64;
const MAX_CONSUMED_PLUGIN_DEEP_LINKS = 256;
const DEFAULT_CONSUMED_DEDUPE_WINDOW_MS = 1_500;
const PLUGIN_DEEP_LINK_RETRY_DELAYS_MS = [250, 1_000] as const;
const DELIVERY_ID_PATTERN = /^plugin-deep-link-[1-9]\d*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const MOSS_PLUGIN_DEEP_LINK_ACK_TIMEOUT_MS = 5_000;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function isOwnedMossScheme(value: string): boolean {
  return value === MOSS_DESKTOP_SCHEME || value === MOSS_CANARY_DESKTOP_SCHEME;
}

function canonicalizeEncodedPluginId(encodedPluginId: string): string | null {
  if (
    encodedPluginId.length === 0 ||
    encodedPluginId.includes("/") ||
    encodedPluginId.includes("?") ||
    encodedPluginId.includes("#") ||
    hasControlCharacters(encodedPluginId)
  ) {
    return null;
  }

  let pluginId: string;
  try {
    pluginId = decodeURIComponent(encodedPluginId);
  } catch {
    return null;
  }

  if (
    pluginId.length === 0 ||
    pluginId.length > MAX_PLUGIN_ID_LENGTH ||
    pluginId !== pluginId.trim() ||
    pluginId === "." ||
    pluginId === ".." ||
    pluginId.includes("/") ||
    hasControlCharacters(pluginId)
  ) {
    return null;
  }

  return encodeURIComponent(pluginId);
}

/**
 * Map only an exact, flavor-owned `scheme://plugins/<encodedId>` URL to the
 * renderer's canonical detail route. `codex://` is intentionally never owned.
 */
export function resolveMossPluginDeepLinkRoute(
  rawUrl: unknown,
  expectedScheme: string,
): DesktopPluginDeepLinkRoute | null {
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_PLUGIN_DEEP_LINK_URL_LENGTH ||
    rawUrl !== rawUrl.trim() ||
    hasControlCharacters(rawUrl) ||
    !isOwnedMossScheme(expectedScheme)
  ) {
    return null;
  }

  const prefix = `${expectedScheme}://${PLUGIN_DEEP_LINK_HOST}/`;
  if (!rawUrl.startsWith(prefix)) {
    return null;
  }

  const canonicalPluginId = canonicalizeEncodedPluginId(rawUrl.slice(prefix.length));
  return canonicalPluginId ? `${PLUGIN_DEEP_LINK_ROUTE_PREFIX}${canonicalPluginId}` : null;
}

/** Resolve the first exact plugin deep link supplied by Electron in argv. */
export function resolveMossPluginDeepLinkRouteFromArgv(
  argv: ReadonlyArray<string>,
  expectedScheme: string,
): DesktopPluginDeepLinkRoute | null {
  for (const argument of argv) {
    const route = resolveMossPluginDeepLinkRoute(argument, expectedScheme);
    if (route) {
      return route;
    }
  }
  return null;
}

/** Runtime guard used on both sides of the context-isolated IPC boundary. */
export function isMossPluginDeepLinkRoute(value: unknown): value is DesktopPluginDeepLinkRoute {
  if (typeof value !== "string" || !value.startsWith(PLUGIN_DEEP_LINK_ROUTE_PREFIX)) {
    return false;
  }
  const encodedPluginId = value.slice(PLUGIN_DEEP_LINK_ROUTE_PREFIX.length);
  return canonicalizeEncodedPluginId(encodedPluginId) === encodedPluginId;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isDesktopPluginDeepLinkSource(value: unknown): value is DesktopPluginDeepLinkSource {
  return value === "initial-argv" || value === "open-url" || value === "second-instance";
}

function isConsistentPluginDeepLinkOrigin(
  coldStart: boolean,
  source: DesktopPluginDeepLinkSource,
): boolean {
  return (
    source === "open-url" ||
    (source === "initial-argv" && coldStart) ||
    (source === "second-instance" && !coldStart)
  );
}

export function isDesktopPluginDeepLinkNavigation(
  value: unknown,
): value is DesktopPluginDeepLinkNavigation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record, ["deliveryId", "route", "coldStart", "source"]) &&
    typeof record.deliveryId === "string" &&
    DELIVERY_ID_PATTERN.test(record.deliveryId) &&
    isMossPluginDeepLinkRoute(record.route) &&
    typeof record.coldStart === "boolean" &&
    isDesktopPluginDeepLinkSource(record.source) &&
    isConsistentPluginDeepLinkOrigin(record.coldStart, record.source)
  );
}

export function isDesktopPluginDeepLinkNavigationResult(
  value: unknown,
): value is DesktopPluginDeepLinkNavigationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record, ["deliveryId", "accepted"]) &&
    typeof record.deliveryId === "string" &&
    DELIVERY_ID_PATTERN.test(record.deliveryId) &&
    typeof record.accepted === "boolean"
  );
}

export function isDesktopPluginDeepLinkAudit(value: unknown): value is DesktopPluginDeepLinkAudit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record, ["deliveryIdSha256", "coldStart", "source", "rendererAcknowledged"]) &&
    typeof record.deliveryIdSha256 === "string" &&
    SHA256_PATTERN.test(record.deliveryIdSha256) &&
    typeof record.coldStart === "boolean" &&
    isDesktopPluginDeepLinkSource(record.source) &&
    isConsistentPluginDeepLinkOrigin(record.coldStart, record.source) &&
    typeof record.rendererAcknowledged === "boolean"
  );
}

export function resolveMossPluginDeepLinkRetryDelay(consecutiveFailures: number): number | null {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) {
    return null;
  }
  return PLUGIN_DEEP_LINK_RETRY_DELAYS_MS[consecutiveFailures] ?? null;
}

/**
 * Bounds a single renderer delivery attempt. Main retains the queue entry and
 * decides whether to retry when the callback fires.
 */
export class MossPluginDeepLinkAckWatchdog {
  readonly #onTimeout: (deliveryId: string) => void;
  readonly #timeoutMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #deliveryId: string | null = null;

  constructor(
    onTimeout: (deliveryId: string) => void,
    timeoutMs = MOSS_PLUGIN_DEEP_LINK_ACK_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Plugin deep-link ACK timeout must be a positive finite number.");
    }
    this.#onTimeout = onTimeout;
    this.#timeoutMs = timeoutMs;
  }

  arm(deliveryId: string): void {
    if (!DELIVERY_ID_PATTERN.test(deliveryId)) {
      throw new Error("Plugin deep-link watchdog requires a canonical delivery id.");
    }
    this.clear();
    this.#deliveryId = deliveryId;
    this.#timer = setTimeout(() => {
      const timedOutDeliveryId = this.#deliveryId;
      this.#timer = null;
      this.#deliveryId = null;
      if (timedOutDeliveryId) {
        this.#onTimeout(timedOutDeliveryId);
      }
    }, this.#timeoutMs);
    this.#timer.unref();
  }

  clear(deliveryId?: string): boolean {
    if (!this.#timer || (deliveryId !== undefined && deliveryId !== this.#deliveryId)) {
      return false;
    }
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#deliveryId = null;
    return true;
  }
}

interface PendingPluginDeepLink {
  readonly deliveryId: string;
  readonly route: DesktopPluginDeepLinkRoute;
  readonly coldStart: boolean;
  readonly source: DesktopPluginDeepLinkSource;
}

interface ConsumedPluginDeepLink {
  readonly route: DesktopPluginDeepLinkRoute;
  readonly consumedAt: number;
}

/**
 * Process-lifetime FIFO. Pending routes are deduplicated, successful routes are
 * remembered, and a NACK/reload clears only the delivery attempt—not the logical
 * activation or its stable delivery ID.
 */
export class MossPluginDeepLinkNavigationQueue {
  readonly #expectedScheme: string;
  readonly #now: () => number;
  readonly #consumedDedupeWindowMs: number;
  readonly #pending: PendingPluginDeepLink[] = [];
  readonly #pendingRoutes = new Set<DesktopPluginDeepLinkRoute>();
  readonly #consumedRoutes = new Map<DesktopPluginDeepLinkRoute, number>();
  readonly #consumedOrder: ConsumedPluginDeepLink[] = [];
  #inFlight: DesktopPluginDeepLinkNavigation | null = null;
  #nextDeliverySequence = 1;

  constructor(
    expectedScheme: string,
    options: {
      readonly now?: () => number;
      readonly consumedDedupeWindowMs?: number;
    } = {},
  ) {
    if (!isOwnedMossScheme(expectedScheme)) {
      throw new Error("Plugin deep links require a Moss-owned desktop scheme.");
    }
    this.#expectedScheme = expectedScheme;
    this.#now = options.now ?? Date.now;
    this.#consumedDedupeWindowMs =
      options.consumedDedupeWindowMs ?? DEFAULT_CONSUMED_DEDUPE_WINDOW_MS;
    if (!Number.isFinite(this.#consumedDedupeWindowMs) || this.#consumedDedupeWindowMs < 0) {
      throw new Error("Plugin deep-link dedupe window must be a non-negative finite number.");
    }
  }

  get expectedScheme(): string {
    return this.#expectedScheme;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  enqueueUrl(rawUrl: unknown, coldStart: boolean, source: DesktopPluginDeepLinkSource): boolean {
    const route = resolveMossPluginDeepLinkRoute(rawUrl, this.#expectedScheme);
    const consumedAt = route ? this.#consumedRoutes.get(route) : undefined;
    if (route && consumedAt !== undefined) {
      const elapsed = this.#now() - consumedAt;
      if (elapsed >= 0 && elapsed <= this.#consumedDedupeWindowMs) {
        return false;
      }
      this.#consumedRoutes.delete(route);
    }
    if (
      !route ||
      typeof coldStart !== "boolean" ||
      !isDesktopPluginDeepLinkSource(source) ||
      !isConsistentPluginDeepLinkOrigin(coldStart, source) ||
      this.#pending.length >= MAX_PENDING_PLUGIN_DEEP_LINKS ||
      this.#pendingRoutes.has(route)
    ) {
      return false;
    }
    this.#pending.push({
      deliveryId: `plugin-deep-link-${this.#nextDeliverySequence}`,
      route,
      coldStart,
      source,
    });
    this.#nextDeliverySequence += 1;
    this.#pendingRoutes.add(route);
    return true;
  }

  enqueueArgv(
    argv: ReadonlyArray<string>,
    coldStart: boolean,
    source: DesktopPluginDeepLinkSource,
  ): number {
    let accepted = 0;
    for (const argument of argv) {
      if (this.enqueueUrl(argument, coldStart, source)) {
        accepted += 1;
      }
    }
    return accepted;
  }

  beginDelivery(): DesktopPluginDeepLinkNavigation | null {
    if (this.#inFlight || this.#pending.length === 0) {
      return null;
    }
    const next = this.#pending[0];
    if (!next) {
      return null;
    }
    this.#inFlight = {
      deliveryId: next.deliveryId,
      route: next.route,
      coldStart: next.coldStart,
      source: next.source,
    };
    return this.#inFlight;
  }

  settleDelivery(deliveryId: string, accepted: boolean): boolean {
    if (!this.#inFlight || this.#inFlight.deliveryId !== deliveryId) {
      return false;
    }
    const settled = this.#inFlight;
    this.#inFlight = null;
    if (!accepted) {
      return true;
    }

    const next = this.#pending.shift();
    if (!next || next.deliveryId !== settled.deliveryId || next.route !== settled.route) {
      throw new Error("Plugin deep-link delivery queue lost FIFO ownership.");
    }
    this.#pendingRoutes.delete(next.route);
    this.#rememberConsumed(next.route);
    return true;
  }

  cancelInFlightDelivery(): boolean {
    if (!this.#inFlight) {
      return false;
    }
    this.#inFlight = null;
    return true;
  }

  getInFlightDelivery(deliveryId: string): DesktopPluginDeepLinkNavigation | null {
    return this.#inFlight?.deliveryId === deliveryId ? this.#inFlight : null;
  }

  #rememberConsumed(route: DesktopPluginDeepLinkRoute): void {
    const consumedAt = this.#now();
    this.#consumedRoutes.set(route, consumedAt);
    this.#consumedOrder.push({ route, consumedAt });
    while (this.#consumedOrder.length > MAX_CONSUMED_PLUGIN_DEEP_LINKS) {
      const expired = this.#consumedOrder.shift();
      if (expired && this.#consumedRoutes.get(expired.route) === expired.consumedAt) {
        this.#consumedRoutes.delete(expired.route);
      }
    }
  }
}

export interface MossPluginDeepLinkAppEvents {
  isReady(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface MossPluginDeepLinkAppEventRegistration {
  readonly initialAcceptedCount: number;
  readonly dispose: () => void;
}

/**
 * Capture all three Electron delivery paths without touching the auth or
 * connector callback parsers. A valid duplicate is still recognized as an
 * owned OS URL, while queue deduplication prevents a second router PUSH.
 */
export function installMossPluginDeepLinkAppEvents(input: {
  readonly app: MossPluginDeepLinkAppEvents;
  readonly queue: MossPluginDeepLinkNavigationQueue;
  readonly initialArgv: ReadonlyArray<string>;
  readonly onDeepLinkRecognized: () => void;
}): MossPluginDeepLinkAppEventRegistration {
  const initialAcceptedCount = input.queue.enqueueArgv(input.initialArgv, true, "initial-argv");

  const handleOpenUrl = (event: unknown, rawUrl: unknown): void => {
    if (
      typeof rawUrl !== "string" ||
      resolveMossPluginDeepLinkRoute(rawUrl, input.queue.expectedScheme) === null
    ) {
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
    input.queue.enqueueUrl(rawUrl, !input.app.isReady(), "open-url");
    input.onDeepLinkRecognized();
  };

  const handleSecondInstance = (_event: unknown, argv: unknown): void => {
    if (
      !Array.isArray(argv) ||
      !argv.every((value) => typeof value === "string") ||
      resolveMossPluginDeepLinkRouteFromArgv(argv, input.queue.expectedScheme) === null
    ) {
      return;
    }
    input.queue.enqueueArgv(argv, false, "second-instance");
    input.onDeepLinkRecognized();
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
