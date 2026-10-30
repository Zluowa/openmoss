import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MOSS_PLUGIN_DEEP_LINK_ACK_TIMEOUT_MS,
  MossPluginDeepLinkAckWatchdog,
  MossPluginDeepLinkNavigationQueue,
  installMossPluginDeepLinkAppEvents,
  isDesktopPluginDeepLinkAudit,
  isDesktopPluginDeepLinkNavigation,
  isDesktopPluginDeepLinkNavigationResult,
  isMossPluginDeepLinkRoute,
  resolveMossPluginDeepLinkRetryDelay,
  resolveMossPluginDeepLinkRoute,
  resolveMossPluginDeepLinkRouteFromArgv,
} from "./pluginDeepLink";

describe("resolveMossPluginDeepLinkRoute", () => {
  it.each([
    ["moss://plugins/browser%40openai-curated", "moss", "/skills/plugins/browser%40openai-curated"],
    ["moss://plugins/caf%c3%a9", "moss", "/skills/plugins/caf%C3%A9"],
    [
      "moss-canary://plugins/%E5%9B%BE%E5%83%8F%40catalog",
      "moss-canary",
      "/skills/plugins/%E5%9B%BE%E5%83%8F%40catalog",
    ],
  ])("maps %s to a canonical renderer route", (rawUrl, expectedScheme, expectedRoute) => {
    expect(resolveMossPluginDeepLinkRoute(rawUrl, expectedScheme)).toBe(expectedRoute);
  });

  it.each([
    ["codex://plugins/browser", "moss"],
    ["https://plugins/browser", "moss"],
    ["moss-canary://plugins/browser", "moss"],
    ["moss://plugins/browser", "moss-canary"],
    ["MOSS://plugins/browser", "moss"],
    ["moss://PLUGINS/browser", "moss"],
    ["moss://user@plugins/browser", "moss"],
    ["moss://user:password@plugins/browser", "moss"],
    ["moss://plugins:443/browser", "moss"],
    ["moss://auth/callback?code=auth-code", "moss"],
    ["moss-connectors://connector/oauth_callback", "moss"],
    ["moss://plugins", "moss"],
    ["moss://plugins/", "moss"],
    ["moss://plugins/browser/extra", "moss"],
    ["moss://plugins/browser/", "moss"],
    ["moss://plugins/browser?source=external", "moss"],
    ["moss://plugins/browser#detail", "moss"],
    ["moss://plugins/%", "moss"],
    ["moss://plugins/%2", "moss"],
    ["moss://plugins/%E0%A4%A", "moss"],
    ["moss://plugins/plugin%2Fgithub", "moss"],
    ["moss://plugins/plugin%2fgithub", "moss"],
    ["moss://plugins/%00", "moss"],
    ["moss://plugins/%0A", "moss"],
    ["moss://plugins/%7F", "moss"],
    ["moss://plugins/%20browser", "moss"],
    ["moss://plugins/browser%20", "moss"],
    ["moss://plugins/.", "moss"],
    ["moss://plugins/..", "moss"],
    [" moss://plugins/browser", "moss"],
    ["moss://plugins/browser\n", "moss"],
    ["not a URL", "moss"],
    ["", "moss"],
  ])("rejects an untrusted or malformed deep link: %s", (rawUrl, expectedScheme) => {
    expect(resolveMossPluginDeepLinkRoute(rawUrl, expectedScheme)).toBeNull();
  });

  it("bounds the raw URL and decoded plugin id", () => {
    expect(resolveMossPluginDeepLinkRoute(`moss://plugins/${"a".repeat(1024)}`, "moss")).toBe(
      `/skills/plugins/${"a".repeat(1024)}`,
    );
    expect(resolveMossPluginDeepLinkRoute(`moss://plugins/${"a".repeat(1025)}`, "moss")).toBeNull();
    expect(resolveMossPluginDeepLinkRoute(`moss://plugins/${"a".repeat(8192)}`, "moss")).toBeNull();
  });

  it("extracts only exact standalone URLs from argv", () => {
    expect(
      resolveMossPluginDeepLinkRouteFromArgv(
        [
          "/Applications/Moss.app/Contents/MacOS/Moss",
          "--url=moss://plugins/ignored",
          "moss://auth/callback?code=ignored",
          "moss://plugins/browser%40openai-curated",
        ],
        "moss",
      ),
    ).toBe("/skills/plugins/browser%40openai-curated");
    expect(
      resolveMossPluginDeepLinkRouteFromArgv(["Moss", "codex://plugins/browser"], "moss"),
    ).toBeNull();
  });
});

describe("isMossPluginDeepLinkRoute", () => {
  it("accepts only canonical renderer plugin detail routes", () => {
    expect(isMossPluginDeepLinkRoute("/skills/plugins/browser%40openai-curated")).toBe(true);
    expect(isMossPluginDeepLinkRoute("/skills/plugins/browser@openai-curated")).toBe(false);
    expect(isMossPluginDeepLinkRoute("/skills/plugins/caf%c3%a9")).toBe(false);
    expect(isMossPluginDeepLinkRoute("/skills/plugins/plugin%2Fgithub")).toBe(false);
    expect(isMossPluginDeepLinkRoute("/skills/plugins/browser?tab=apps")).toBe(false);
    expect(isMossPluginDeepLinkRoute("/skills/plugins/")).toBe(false);
    expect(isMossPluginDeepLinkRoute("/skills/manage/plugins/browser")).toBe(false);
  });
});

describe("MossPluginDeepLinkNavigationQueue", () => {
  it("queues cold-start argv, deduplicates delivery, and consumes only an ACK", () => {
    const queue = new MossPluginDeepLinkNavigationQueue("moss");

    expect(
      queue.enqueueArgv(["Moss", "moss://plugins/browser%40openai-curated"], true, "initial-argv"),
    ).toBe(1);
    expect(queue.enqueueUrl("moss://plugins/browser%40openai-curated", true, "open-url")).toBe(
      false,
    );
    expect(queue.pendingCount).toBe(1);

    const first = queue.beginDelivery();
    expect(first).toEqual({
      deliveryId: "plugin-deep-link-1",
      route: "/skills/plugins/browser%40openai-curated",
      coldStart: true,
      source: "initial-argv",
    });
    expect(queue.beginDelivery()).toBeNull();
    expect(queue.settleDelivery(first?.deliveryId ?? "", false)).toBe(true);
    expect(queue.pendingCount).toBe(1);

    const retry = queue.beginDelivery();
    expect(retry).toEqual({
      deliveryId: "plugin-deep-link-1",
      route: "/skills/plugins/browser%40openai-curated",
      coldStart: true,
      source: "initial-argv",
    });
    expect(queue.settleDelivery(retry?.deliveryId ?? "", true)).toBe(true);
    expect(queue.pendingCount).toBe(0);
    expect(queue.enqueueUrl("moss://plugins/browser%40openai-curated", false, "open-url")).toBe(
      false,
    );
  });

  it("preserves FIFO ordering and ignores stale acknowledgements", () => {
    const queue = new MossPluginDeepLinkNavigationQueue("moss-canary");
    expect(queue.enqueueUrl("moss-canary://plugins/one", false, "open-url")).toBe(true);
    expect(queue.enqueueUrl("moss-canary://plugins/two", false, "second-instance")).toBe(true);

    const first = queue.beginDelivery();
    expect(first?.route).toBe("/skills/plugins/one");
    expect(first?.coldStart).toBe(false);
    expect(first?.source).toBe("open-url");
    expect(queue.settleDelivery("plugin-deep-link-stale", true)).toBe(false);
    expect(queue.cancelInFlightDelivery()).toBe(true);

    const retry = queue.beginDelivery();
    expect(retry?.deliveryId).toBe(first?.deliveryId);
    expect(retry?.route).toBe("/skills/plugins/one");
    expect(retry?.coldStart).toBe(false);
    expect(retry?.source).toBe("open-url");
    expect(queue.settleDelivery(retry?.deliveryId ?? "", true)).toBe(true);
    const second = queue.beginDelivery();
    expect(second?.deliveryId).toBe("plugin-deep-link-2");
    expect(second?.route).toBe("/skills/plugins/two");
    expect(second?.coldStart).toBe(false);
    expect(second?.source).toBe("second-instance");
    expect(queue.settleDelivery(first?.deliveryId ?? "", true)).toBe(false);
  });

  it("deduplicates duplicate OS delivery without blocking a later intentional reopen", () => {
    let now = 10_000;
    const queue = new MossPluginDeepLinkNavigationQueue("moss", {
      now: () => now,
      consumedDedupeWindowMs: 1_500,
    });
    expect(queue.enqueueUrl("moss://plugins/browser", false, "open-url")).toBe(true);
    const delivery = queue.beginDelivery();
    expect(queue.settleDelivery(delivery?.deliveryId ?? "", true)).toBe(true);
    expect(queue.enqueueUrl("moss://plugins/browser", false, "open-url")).toBe(false);

    now += 1_501;
    expect(queue.enqueueUrl("moss://plugins/browser", false, "open-url")).toBe(true);
    expect(queue.beginDelivery()?.deliveryId).toBe("plugin-deep-link-2");
  });

  it("bounds the pending queue without displacing already accepted routes", () => {
    const queue = new MossPluginDeepLinkNavigationQueue("moss");
    for (let index = 0; index < 64; index += 1) {
      expect(queue.enqueueUrl(`moss://plugins/plugin-${index}`, false, "open-url")).toBe(true);
    }
    expect(queue.pendingCount).toBe(64);
    expect(queue.enqueueUrl("moss://plugins/overflow", false, "open-url")).toBe(false);
    expect(queue.pendingCount).toBe(64);
    expect(queue.beginDelivery()?.route).toBe("/skills/plugins/plugin-0");
  });

  it("isolates plugin links from auth and connector callback URLs", () => {
    const queue = new MossPluginDeepLinkNavigationQueue("moss");
    expect(queue.enqueueArgv(["moss://auth/callback?code=secret"], true, "initial-argv")).toBe(0);
    expect(
      queue.enqueueArgv(
        ["moss-connectors://connector/oauth_callback?fullRedirectUrl=https%3A%2F%2Fexample.test"],
        true,
        "initial-argv",
      ),
    ).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  it("retains cold/source metadata when a renderer reload cancels an in-flight delivery", () => {
    const queue = new MossPluginDeepLinkNavigationQueue("moss");
    expect(queue.enqueueUrl("moss://plugins/reload", true, "open-url")).toBe(true);
    const beforeReload = queue.beginDelivery();
    expect(beforeReload).toMatchObject({ coldStart: true, source: "open-url" });

    expect(queue.cancelInFlightDelivery()).toBe(true);
    const afterReload = queue.beginDelivery();
    expect(afterReload).toMatchObject({
      route: "/skills/plugins/reload",
      coldStart: true,
      source: "open-url",
    });
    expect(afterReload?.deliveryId).toBe(beforeReload?.deliveryId);
  });
});

describe("MossPluginDeepLinkAckWatchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers a retained queue entry when renderer ACK never arrives", () => {
    vi.useFakeTimers();
    const queue = new MossPluginDeepLinkNavigationQueue("moss");
    queue.enqueueUrl("moss://plugins/one", false, "open-url");
    queue.enqueueUrl("moss://plugins/two", false, "open-url");
    const first = queue.beginDelivery();
    expect(first).not.toBeNull();

    const timedOut = vi.fn((deliveryId: string) => {
      if (queue.getInFlightDelivery(deliveryId)) {
        queue.cancelInFlightDelivery();
      }
    });
    const watchdog = new MossPluginDeepLinkAckWatchdog(timedOut);
    watchdog.arm(first?.deliveryId ?? "");
    vi.advanceTimersByTime(MOSS_PLUGIN_DEEP_LINK_ACK_TIMEOUT_MS);

    expect(timedOut).toHaveBeenCalledWith(first?.deliveryId);
    expect(queue.beginDelivery()).toMatchObject({
      route: "/skills/plugins/one",
      coldStart: false,
      source: "open-url",
    });
  });

  it("does not time out a delivery cleared by a matching ACK", () => {
    vi.useFakeTimers();
    const timedOut = vi.fn();
    const watchdog = new MossPluginDeepLinkAckWatchdog(timedOut);
    watchdog.arm("plugin-deep-link-1");
    expect(watchdog.clear("plugin-deep-link-stale")).toBe(false);
    expect(watchdog.clear("plugin-deep-link-1")).toBe(true);
    vi.advanceTimersByTime(MOSS_PLUGIN_DEEP_LINK_ACK_TIMEOUT_MS);
    expect(timedOut).not.toHaveBeenCalled();
  });
});

describe("resolveMossPluginDeepLinkRetryDelay", () => {
  it("permits two bounded retries and then retains the route for a future activation", () => {
    expect(resolveMossPluginDeepLinkRetryDelay(0)).toBe(250);
    expect(resolveMossPluginDeepLinkRetryDelay(1)).toBe(1_000);
    expect(resolveMossPluginDeepLinkRetryDelay(2)).toBeNull();
    expect(resolveMossPluginDeepLinkRetryDelay(99)).toBeNull();
  });
});

class FakeDeepLinkApp {
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  ready = false;

  isReady(): boolean {
    return this.ready;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

describe("installMossPluginDeepLinkAppEvents", () => {
  it("marks initial argv and pre-ready macOS delivery cold, then running OS delivery warm", () => {
    const app = new FakeDeepLinkApp();
    const queue = new MossPluginDeepLinkNavigationQueue("moss");
    let recognized = 0;
    const registration = installMossPluginDeepLinkAppEvents({
      app,
      queue,
      initialArgv: ["Moss", "moss://plugins/cold"],
      onDeepLinkRecognized: () => {
        recognized += 1;
      },
    });

    expect(registration.initialAcceptedCount).toBe(1);
    expect(queue.pendingCount).toBe(1);

    const duplicateEvent = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    app.emit("open-url", duplicateEvent, "moss://plugins/cold");
    expect(duplicateEvent.prevented).toBe(true);
    expect(recognized).toBe(1);
    expect(queue.pendingCount).toBe(1);

    app.emit("open-url", duplicateEvent, "moss://plugins/pre-ready-mac");
    expect(recognized).toBe(2);
    expect(queue.pendingCount).toBe(2);

    app.ready = true;
    app.emit("open-url", duplicateEvent, "moss://plugins/warm-mac");
    app.emit("second-instance", {}, ["Moss", "moss://plugins/warm-secondary"], "/tmp", {});
    expect(recognized).toBe(4);
    expect(queue.pendingCount).toBe(4);

    const observedDeliveries = [];
    while (queue.pendingCount > 0) {
      const delivery = queue.beginDelivery();
      expect(delivery).not.toBeNull();
      observedDeliveries.push({
        route: delivery?.route,
        coldStart: delivery?.coldStart,
        source: delivery?.source,
      });
      expect(queue.settleDelivery(delivery?.deliveryId ?? "", true)).toBe(true);
    }
    expect(observedDeliveries).toEqual([
      { route: "/skills/plugins/cold", coldStart: true, source: "initial-argv" },
      { route: "/skills/plugins/pre-ready-mac", coldStart: true, source: "open-url" },
      { route: "/skills/plugins/warm-mac", coldStart: false, source: "open-url" },
      {
        route: "/skills/plugins/warm-secondary",
        coldStart: false,
        source: "second-instance",
      },
    ]);

    const authEvent = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    app.emit("open-url", authEvent, "moss://auth/callback?code=secret");
    expect(authEvent.prevented).toBe(false);
    expect(recognized).toBe(4);

    registration.dispose();
    expect(app.listeners.get("open-url")?.size).toBe(0);
    expect(app.listeners.get("second-instance")?.size).toBe(0);
  });

  it("uses the canary scheme without accepting production or Codex ownership", () => {
    const app = new FakeDeepLinkApp();
    const queue = new MossPluginDeepLinkNavigationQueue("moss-canary");
    const registration = installMossPluginDeepLinkAppEvents({
      app,
      queue,
      initialArgv: [
        "Moss Canary",
        "moss://plugins/stable",
        "codex://plugins/codex",
        "moss-canary://plugins/canary",
      ],
      onDeepLinkRecognized: () => undefined,
    });

    expect(registration.initialAcceptedCount).toBe(1);
    expect(queue.beginDelivery()?.route).toBe("/skills/plugins/canary");
  });
});

describe("plugin deep-link IPC validation", () => {
  it("accepts the exact canonical navigation and result shapes", () => {
    expect(
      isDesktopPluginDeepLinkNavigation({
        deliveryId: "plugin-deep-link-42",
        route: "/skills/plugins/browser%40openai-curated",
        coldStart: false,
        source: "open-url",
      }),
    ).toBe(true);
    expect(
      isDesktopPluginDeepLinkNavigationResult({
        deliveryId: "plugin-deep-link-42",
        accepted: true,
      }),
    ).toBe(true);
  });

  it.each([
    null,
    {},
    { deliveryId: "plugin-deep-link-1", route: "/settings" },
    { deliveryId: "../1", route: "/skills/plugins/browser", coldStart: false },
    {
      deliveryId: "plugin-deep-link-1",
      route: "/skills/plugins/browser",
      coldStart: false,
    },
    {
      deliveryId: "plugin-deep-link-1",
      route: "/skills/plugins/browser",
      coldStart: "true",
      source: "open-url",
    },
    {
      deliveryId: "plugin-deep-link-1",
      route: "/skills/plugins/browser",
      coldStart: true,
      source: "second-instance",
    },
    {
      deliveryId: "plugin-deep-link-1",
      route: "/skills/plugins/browser",
      coldStart: false,
      source: "open-url",
      arbitraryUrl: "https://evil.test",
    },
  ])("rejects malformed navigation payloads", (value) => {
    expect(isDesktopPluginDeepLinkNavigation(value)).toBe(false);
  });

  it.each([
    null,
    {},
    { deliveryId: "plugin-deep-link-1", accepted: "true" },
    { deliveryId: "../1", accepted: true },
    { deliveryId: "plugin-deep-link-1", accepted: true, route: "/settings" },
  ])("rejects malformed acknowledgement payloads", (value) => {
    expect(isDesktopPluginDeepLinkNavigationResult(value)).toBe(false);
  });

  it("accepts only a raw-safe latest-delivery audit", () => {
    expect(
      isDesktopPluginDeepLinkAudit({
        deliveryIdSha256: "a".repeat(64),
        coldStart: true,
        source: "open-url",
        rendererAcknowledged: true,
      }),
    ).toBe(true);
    expect(
      isDesktopPluginDeepLinkAudit({
        deliveryIdSha256: "plugin-deep-link-1",
        coldStart: true,
        source: "open-url",
        rendererAcknowledged: true,
      }),
    ).toBe(false);
    expect(
      isDesktopPluginDeepLinkAudit({
        deliveryIdSha256: "a".repeat(64),
        coldStart: true,
        source: "second-instance",
        rendererAcknowledged: true,
      }),
    ).toBe(false);
    expect(
      isDesktopPluginDeepLinkAudit({
        deliveryIdSha256: "a".repeat(64),
        coldStart: false,
        source: "open-url",
        rendererAcknowledged: true,
        route: "/skills/plugins/secret",
      }),
    ).toBe(false);
  });
});
