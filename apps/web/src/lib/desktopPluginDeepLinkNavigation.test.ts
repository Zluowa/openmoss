// FILE: desktopPluginDeepLinkNavigation.test.ts
// Purpose: Locks the renderer-side trust boundary and ACK lifecycle for desktop plugin deep links.
// Layer: Web routing utility test

import type { DesktopPluginDeepLinkNavigation } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  parseDesktopPluginDeepLinkNavigation,
  parseDesktopPluginDeepLinkRoute,
  subscribeDesktopPluginDeepLinkNavigation,
} from "./desktopPluginDeepLinkNavigation";

type DeepLinkListener = (navigation: DesktopPluginDeepLinkNavigation) => boolean | Promise<boolean>;

describe("parseDesktopPluginDeepLinkRoute", () => {
  it("accepts only canonical encoded browse-detail routes", () => {
    expect(parseDesktopPluginDeepLinkRoute("/skills/plugins/github%40openai-curated")).toBe(
      "github@openai-curated",
    );
    expect(parseDesktopPluginDeepLinkRoute("/skills/plugins/github@openai-curated")).toBeNull();
    expect(parseDesktopPluginDeepLinkRoute("/skills/plugins/github%2Fadmin")).toBeNull();
    expect(parseDesktopPluginDeepLinkRoute("/skills/plugins/.")).toBeNull();
    expect(parseDesktopPluginDeepLinkRoute("/skills/plugins/..")).toBeNull();
    expect(parseDesktopPluginDeepLinkRoute("/skills/plugins/%C2%85")).toBeNull();
    expect(parseDesktopPluginDeepLinkRoute("/skills/plugins/%E0%A4%A")).toBeNull();
    expect(parseDesktopPluginDeepLinkRoute("/skills/plugins/")).toBeNull();
    expect(
      parseDesktopPluginDeepLinkRoute("/skills/manage/plugins/github%40openai-curated"),
    ).toBeNull();
    expect(
      parseDesktopPluginDeepLinkRoute("/skills/plugins/github%40openai-curated?install=true"),
    ).toBeNull();
    expect(
      parseDesktopPluginDeepLinkRoute("/skills/plugins/github%40openai-curated#details"),
    ).toBeNull();
  });
});

describe("parseDesktopPluginDeepLinkNavigation", () => {
  const canonicalNavigation = {
    deliveryId: "plugin-deep-link-1",
    route: "/skills/plugins/github%40openai-curated",
    coldStart: false,
    source: "second-instance",
  } as const;

  it("accepts the exact desktop payload and returns the decoded plugin id", () => {
    expect(parseDesktopPluginDeepLinkNavigation(canonicalNavigation)).toEqual({
      ...canonicalNavigation,
      pluginId: "github@openai-curated",
    });
  });

  it.each([
    [
      "missing source",
      {
        deliveryId: canonicalNavigation.deliveryId,
        route: canonicalNavigation.route,
        coldStart: false,
      },
    ],
    ["unknown source", { ...canonicalNavigation, source: "unknown" }],
    ["extra key", { ...canonicalNavigation, extra: true }],
    ["noncanonical delivery id", { ...canonicalNavigation, deliveryId: "delivery-1" }],
    ["cold second instance", { ...canonicalNavigation, coldStart: true }],
    ["warm initial argv", { ...canonicalNavigation, coldStart: false, source: "initial-argv" }],
  ])("rejects %s", (_label, navigation) => {
    expect(parseDesktopPluginDeepLinkNavigation(navigation)).toBeNull();
  });

  it("accepts both cold and warm open-url deliveries", () => {
    expect(
      parseDesktopPluginDeepLinkNavigation({
        ...canonicalNavigation,
        coldStart: true,
        source: "open-url",
      }),
    ).not.toBeNull();
    expect(
      parseDesktopPluginDeepLinkNavigation({
        ...canonicalNavigation,
        source: "open-url",
      }),
    ).not.toBeNull();
  });
});

describe("subscribeDesktopPluginDeepLinkNavigation", () => {
  it("PUSHes a valid route, ACKs after navigation, and de-duplicates an ACK-loss retry", async () => {
    let listener: DeepLinkListener | undefined;
    const unsubscribe = vi.fn();
    const bridge = {
      onNavigate: vi.fn((next: typeof listener) => {
        listener = next;
        return unsubscribe;
      }),
    };
    const navigate = vi.fn(async () => undefined);

    const dispose = subscribeDesktopPluginDeepLinkNavigation({
      bridge,
      navigate,
    });
    const navigation = {
      deliveryId: "plugin-deep-link-1",
      route: "/skills/plugins/github%40openai-curated" as const,
      coldStart: false,
      source: "second-instance" as const,
    };

    await expect(Promise.resolve(listener?.(navigation))).resolves.toBe(true);
    await expect(Promise.resolve(listener?.(navigation))).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      pluginId: "github@openai-curated",
      coldStart: false,
      source: "second-instance",
    });

    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("shares one navigation result across concurrent duplicate delivery", async () => {
    let listener: DeepLinkListener | undefined;
    let releaseNavigation: (() => void) | undefined;
    const navigate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseNavigation = resolve;
        }),
    );
    const dispose = subscribeDesktopPluginDeepLinkNavigation({
      bridge: {
        onNavigate(next) {
          listener = next;
          return vi.fn();
        },
      },
      navigate,
    });
    const navigation = {
      deliveryId: "plugin-deep-link-7",
      route: "/skills/plugins/github%40openai-curated" as const,
      coldStart: false,
      source: "second-instance" as const,
    };

    const firstResult = Promise.resolve(listener?.(navigation));
    const duplicateResult = Promise.resolve(listener?.(navigation));
    expect(navigate).toHaveBeenCalledTimes(1);
    releaseNavigation?.();
    await expect(firstResult).resolves.toBe(true);
    await expect(duplicateResult).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);

    dispose();
  });

  it("retries the same stable delivery ID after a navigation NACK", async () => {
    let listener: DeepLinkListener | undefined;
    let navigationAttempts = 0;
    const navigate = vi.fn(async () => {
      navigationAttempts += 1;
      if (navigationAttempts === 1) throw new Error("router unavailable");
    });
    const dispose = subscribeDesktopPluginDeepLinkNavigation({
      bridge: {
        onNavigate(next) {
          listener = next;
          return vi.fn();
        },
      },
      navigate,
    });
    const navigation = {
      deliveryId: "plugin-deep-link-7",
      route: "/skills/plugins/github%40openai-curated" as const,
      coldStart: false,
      source: "second-instance" as const,
    };

    await expect(Promise.resolve(listener?.(navigation))).resolves.toBe(false);
    await expect(Promise.resolve(listener?.(navigation))).resolves.toBe(true);
    await expect(Promise.resolve(listener?.(navigation))).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledTimes(2);

    dispose();
  });

  it("PUSHes a distinct warm activation even when it targets the current route", async () => {
    let listener: DeepLinkListener | undefined;
    const navigate = vi.fn(async () => undefined);
    const dispose = subscribeDesktopPluginDeepLinkNavigation({
      bridge: {
        onNavigate(next) {
          listener = next;
          return vi.fn();
        },
      },
      navigate,
    });

    await expect(
      Promise.resolve(
        listener?.({
          deliveryId: "plugin-deep-link-7",
          route: "/skills/plugins/github%40openai-curated",
          coldStart: false,
          source: "second-instance",
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      Promise.resolve(
        listener?.({
          deliveryId: "plugin-deep-link-8",
          route: "/skills/plugins/github%40openai-curated",
          coldStart: false,
          source: "second-instance",
        }),
      ),
    ).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledTimes(2);

    dispose();
  });

  it("bounds acknowledged delivery history without changing FIFO delivery handling", async () => {
    let listener: DeepLinkListener | undefined;
    const navigate = vi.fn(async () => undefined);
    const dispose = subscribeDesktopPluginDeepLinkNavigation({
      bridge: {
        onNavigate(next) {
          listener = next;
          return vi.fn();
        },
      },
      navigate,
    });

    for (let sequence = 1; sequence <= 129; sequence += 1) {
      await expect(
        Promise.resolve(
          listener?.({
            deliveryId: `plugin-deep-link-${sequence}`,
            route: `/skills/plugins/plugin-${sequence}`,
            coldStart: false,
            source: "second-instance",
          }),
        ),
      ).resolves.toBe(true);
    }
    await expect(
      Promise.resolve(
        listener?.({
          deliveryId: "plugin-deep-link-1",
          route: "/skills/plugins/plugin-1",
          coldStart: false,
          source: "second-instance",
        }),
      ),
    ).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledTimes(130);

    dispose();
  });

  it("NACKs invalid routes and failed or disposed in-flight navigation", async () => {
    let listener: DeepLinkListener | undefined;
    const bridge = {
      onNavigate(next: DeepLinkListener) {
        listener = next;
        return vi.fn();
      },
    };
    const navigate = vi.fn(async () => {
      throw new Error("router unavailable");
    });
    const dispose = subscribeDesktopPluginDeepLinkNavigation({
      bridge,
      navigate,
    });

    await expect(
      Promise.resolve(
        listener?.({
          deliveryId: "plugin-deep-link-2",
          route: "/skills/plugins/github@openai-curated",
          coldStart: false,
          source: "second-instance",
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      Promise.resolve(
        listener?.({
          deliveryId: "plugin-deep-link-3",
          route: "/skills/plugins/github%40openai-curated",
          coldStart: false,
          source: "open-url",
        }),
      ),
    ).resolves.toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);

    let release: (() => void) | undefined;
    const inFlightNavigate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let inFlightListener: DeepLinkListener | undefined;
    const inFlightDispose = subscribeDesktopPluginDeepLinkNavigation({
      bridge: {
        onNavigate(next) {
          inFlightListener = next;
          return vi.fn();
        },
      },
      navigate: inFlightNavigate,
    });
    const result = inFlightListener?.({
      deliveryId: "plugin-deep-link-4",
      route: "/skills/plugins/github%40openai-curated",
      coldStart: false,
      source: "second-instance",
    });
    inFlightDispose();
    release?.();
    await expect(Promise.resolve(result)).resolves.toBe(false);

    dispose();
  });

  it("requires coldStart and does not short-circuit a cold delivery already on its route", async () => {
    let listener: DeepLinkListener | undefined;
    const navigate = vi.fn(async () => undefined);
    const dispose = subscribeDesktopPluginDeepLinkNavigation({
      bridge: {
        onNavigate(next) {
          listener = next;
          return vi.fn();
        },
      },
      navigate,
    });

    await expect(
      Promise.resolve(
        listener?.({
          deliveryId: "plugin-deep-link-5",
          route: "/skills/plugins/github%40openai-curated",
          source: "initial-argv",
        } as unknown as DesktopPluginDeepLinkNavigation),
      ),
    ).resolves.toBe(false);
    await expect(
      Promise.resolve(
        listener?.({
          deliveryId: "plugin-deep-link-6",
          route: "/skills/plugins/github%40openai-curated",
          coldStart: true,
          source: "initial-argv",
        }),
      ),
    ).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledWith({
      pluginId: "github@openai-curated",
      coldStart: true,
      source: "initial-argv",
    });

    dispose();
  });
});
