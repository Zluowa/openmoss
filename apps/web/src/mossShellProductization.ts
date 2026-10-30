// FILE: mossShellProductization.ts
// Purpose: Product-safe gate for the Moss shell route promotion.
// Layer: Web routing/productization state

export type MossShellRouteToggle = "1";
export type MossShellProductizationSource =
  | "default-off"
  | "feature-flag"
  | "product-default"
  | "route-toggle";

export interface MossShellProductizationInput {
  readonly featureFlagEnabled: boolean;
  readonly productDefaultEnabled?: boolean | undefined;
  readonly routeEnabled?: boolean | undefined;
  readonly surfaceMode: "single" | "split";
  readonly presentationMode: "default" | "editor";
}

export interface MossShellProductizationState {
  readonly enabled: boolean;
  readonly source: MossShellProductizationSource;
  readonly mode: "default-off" | "explicit-toggle" | "product-default";
  readonly reason: string;
}

function normalizeRouteToggleString(value: string): string {
  let normalized = value.trim();
  if (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      normalized = normalized.slice(1, -1).trim();
    }
  }
  return normalized.toLowerCase();
}

export function normalizeMossShellRouteToggle(value: unknown): MossShellRouteToggle | undefined {
  if (value === true || value === 1) {
    return "1";
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeRouteToggleString(value);
  return normalized === "1" ||
    normalized === "true" ||
    normalized === "on" ||
    normalized === "yes" ||
    normalized === "enabled"
    ? "1"
    : undefined;
}

export function resolveMossShellProductizationState({
  featureFlagEnabled,
  productDefaultEnabled = false,
  routeEnabled = false,
  surfaceMode,
  presentationMode,
}: MossShellProductizationInput): MossShellProductizationState {
  const source: MossShellProductizationSource = routeEnabled
    ? "route-toggle"
    : productDefaultEnabled
      ? "product-default"
      : featureFlagEnabled
        ? "feature-flag"
        : "default-off";
  const mode =
    source === "product-default"
      ? "product-default"
      : source === "default-off"
        ? "default-off"
        : "explicit-toggle";

  if (!routeEnabled && !productDefaultEnabled && !featureFlagEnabled) {
    return {
      enabled: false,
      source,
      mode,
      reason: "default-off",
    };
  }

  if (surfaceMode !== "single" || presentationMode !== "default") {
    return {
      enabled: false,
      source,
      mode,
      reason: "unsupported-surface",
    };
  }

  return {
    enabled: true,
    source,
    mode,
    reason:
      source === "product-default" ? "product-default-placement" : "normal-product-thread-route",
  };
}
