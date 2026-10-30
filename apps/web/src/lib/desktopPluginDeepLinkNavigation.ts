// FILE: desktopPluginDeepLinkNavigation.ts
// Purpose: Validates desktop plugin-route deliveries and ACKs only committed TanStack navigation.
// Layer: Web routing utility

import type {
  DesktopPluginDeepLinkNavigation,
  DesktopPluginDeepLinkSource,
} from "@synara/contracts";

type DesktopPluginDeepLinkBridge = NonNullable<
  NonNullable<Window["desktopBridge"]>["pluginDeepLinks"]
>;

const PLUGIN_DETAIL_ROUTE_PREFIX = "/skills/plugins/";
const MAX_PLUGIN_ID_LENGTH = 1_024;
const MAX_ACKNOWLEDGED_DELIVERY_IDS = 128;
const DELIVERY_ID_PATTERN = /^plugin-deep-link-[1-9]\d*$/;
const NAVIGATION_KEYS = ["deliveryId", "route", "coldStart", "source"] as const;

export interface ParsedDesktopPluginDeepLinkNavigation extends DesktopPluginDeepLinkNavigation {
  readonly pluginId: string;
}

function isDesktopPluginDeepLinkSource(value: unknown): value is DesktopPluginDeepLinkSource {
  return value === "initial-argv" || value === "open-url" || value === "second-instance";
}

function isConsistentDesktopPluginDeepLinkSource(
  coldStart: boolean,
  source: DesktopPluginDeepLinkSource,
): boolean {
  return (
    source === "open-url" ||
    (source === "initial-argv" && coldStart) ||
    (source === "second-instance" && !coldStart)
  );
}

export function parseDesktopPluginDeepLinkRoute(route: unknown): string | null {
  if (typeof route !== "string" || !route.startsWith(PLUGIN_DETAIL_ROUTE_PREFIX)) return null;
  const encodedPluginId = route.slice(PLUGIN_DETAIL_ROUTE_PREFIX.length);
  if (
    encodedPluginId.length === 0 ||
    encodedPluginId.includes("/") ||
    encodedPluginId.includes("?") ||
    encodedPluginId.includes("#")
  ) {
    return null;
  }

  try {
    const pluginId = decodeURIComponent(encodedPluginId);
    if (
      pluginId.length === 0 ||
      pluginId.length > MAX_PLUGIN_ID_LENGTH ||
      pluginId === "." ||
      pluginId === ".." ||
      pluginId.trim() !== pluginId ||
      /[/\u0000-\u001f\u007f-\u009f]/u.test(pluginId) ||
      encodeURIComponent(pluginId) !== encodedPluginId
    ) {
      return null;
    }
    return pluginId;
  } catch {
    return null;
  }
}

export function parseDesktopPluginDeepLinkNavigation(
  value: unknown,
): ParsedDesktopPluginDeepLinkNavigation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== NAVIGATION_KEYS.length ||
    !NAVIGATION_KEYS.every((key) => keys.includes(key)) ||
    typeof record.deliveryId !== "string" ||
    !DELIVERY_ID_PATTERN.test(record.deliveryId) ||
    typeof record.coldStart !== "boolean" ||
    !isDesktopPluginDeepLinkSource(record.source) ||
    !isConsistentDesktopPluginDeepLinkSource(record.coldStart, record.source)
  ) {
    return null;
  }
  const pluginId = parseDesktopPluginDeepLinkRoute(record.route);
  if (pluginId === null) return null;
  return {
    deliveryId: record.deliveryId,
    route: record.route as DesktopPluginDeepLinkNavigation["route"],
    coldStart: record.coldStart,
    source: record.source,
    pluginId,
  };
}

export function subscribeDesktopPluginDeepLinkNavigation(input: {
  readonly bridge: Pick<DesktopPluginDeepLinkBridge, "onNavigate"> | null | undefined;
  readonly navigate: (input: {
    readonly pluginId: string;
    readonly coldStart: boolean;
    readonly source: DesktopPluginDeepLinkSource;
  }) => Promise<void>;
}): () => void {
  if (!input.bridge) return () => undefined;

  let active = true;
  const acknowledgedDeliveryIds = new Set<string>();
  const acknowledgedDeliveryOrder: string[] = [];
  const inFlightDeliveries = new Map<string, Promise<boolean>>();
  const rememberAcknowledgedDelivery = (deliveryId: string): void => {
    if (acknowledgedDeliveryIds.has(deliveryId)) return;
    acknowledgedDeliveryIds.add(deliveryId);
    acknowledgedDeliveryOrder.push(deliveryId);
    while (acknowledgedDeliveryOrder.length > MAX_ACKNOWLEDGED_DELIVERY_IDS) {
      const expiredDeliveryId = acknowledgedDeliveryOrder.shift();
      if (expiredDeliveryId) acknowledgedDeliveryIds.delete(expiredDeliveryId);
    }
  };
  const unsubscribe = input.bridge.onNavigate(
    async (navigation: DesktopPluginDeepLinkNavigation): Promise<boolean> => {
      if (!active) return false;
      const parsedNavigation = parseDesktopPluginDeepLinkNavigation(navigation);
      if (!parsedNavigation) return false;
      if (acknowledgedDeliveryIds.has(parsedNavigation.deliveryId)) return true;
      const inFlightDelivery = inFlightDeliveries.get(parsedNavigation.deliveryId);
      if (inFlightDelivery) return inFlightDelivery;

      const deliveryResult = (async (): Promise<boolean> => {
        try {
          await input.navigate({
            pluginId: parsedNavigation.pluginId,
            coldStart: parsedNavigation.coldStart,
            source: parsedNavigation.source,
          });
          if (!active) return false;
          rememberAcknowledgedDelivery(parsedNavigation.deliveryId);
          return true;
        } catch {
          return false;
        }
      })();
      inFlightDeliveries.set(parsedNavigation.deliveryId, deliveryResult);
      try {
        return await deliveryResult;
      } finally {
        if (inFlightDeliveries.get(parsedNavigation.deliveryId) === deliveryResult) {
          inFlightDeliveries.delete(parsedNavigation.deliveryId);
        }
      }
    },
  );

  return () => {
    active = false;
    acknowledgedDeliveryIds.clear();
    acknowledgedDeliveryOrder.length = 0;
    inFlightDeliveries.clear();
    unsubscribe();
  };
}
