// FILE: pluginAuthOnboarding.ts
// Purpose: Pure post-install app-auth routing and reconciliation.

import type {
  ProviderAppInfo,
  ProviderPluginAuthPolicy,
  ProviderPluginInstallAppSummary,
} from "@synara/contracts";

export type PluginRequiredAppStatus = "pending" | "launching" | "opened" | "connected";

export interface PluginRequiredApp {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly installUrl: string | null;
  readonly isAccessible: boolean;
  readonly logoUrl: string | null;
  readonly logoUrlDark: string | null;
  readonly status: PluginRequiredAppStatus;
}

export type PluginAuthOnboardingResolution =
  | { readonly kind: "none" }
  | { readonly kind: "single"; readonly app: PluginRequiredApp }
  | { readonly kind: "multiple"; readonly apps: readonly PluginRequiredApp[] };

export function retainedPluginAuthSessionId(input: {
  readonly mode: "single" | "multiple";
  readonly sessionId: number;
  readonly redirectUrl: string | null;
}): number | null {
  return input.mode === "single" && input.redirectUrl !== null ? input.sessionId : null;
}

/**
 * Codex app/list uses the raw `id` from the install result. Display-name joins
 * are intentionally forbidden: two connectors can share a display name and a
 * localized name can change between reads.
 */
export function enrichRequiredPluginApps(
  summaries: ReadonlyArray<ProviderPluginInstallAppSummary>,
  authoritativeApps: ReadonlyArray<ProviderAppInfo>,
): readonly PluginRequiredApp[] {
  const appsById = new Map(authoritativeApps.map((app) => [app.id, app]));
  return summaries.map((summary) => {
    const authoritative = appsById.get(summary.id);
    const isAccessible = authoritative?.isAccessible ?? false;
    return {
      id: summary.id,
      name: authoritative?.name ?? summary.name,
      description: authoritative?.description ?? summary.description,
      installUrl: authoritative?.installUrl ?? summary.installUrl,
      isAccessible,
      logoUrl: authoritative?.logoUrl ?? null,
      logoUrlDark: authoritative?.logoUrlDark ?? null,
      status: isAccessible ? "connected" : "pending",
    };
  });
}

export function resolvePluginAuthOnboarding(
  authPolicy: ProviderPluginAuthPolicy,
  apps: readonly PluginRequiredApp[],
): PluginAuthOnboardingResolution {
  if (authPolicy !== "ON_INSTALL") return { kind: "none" };
  const pending = apps.filter((app) => app.status !== "connected");
  if (pending.length === 0) return { kind: "none" };
  if (pending.length === 1) return { kind: "single", app: pending[0]! };
  return { kind: "multiple", apps };
}

export function reconcileRequiredPluginApps(
  current: readonly PluginRequiredApp[],
  authoritativeApps: ReadonlyArray<ProviderAppInfo>,
): readonly PluginRequiredApp[] {
  const appsById = new Map(authoritativeApps.map((app) => [app.id, app]));
  return current.map((candidate) => {
    const authoritative = appsById.get(candidate.id);
    if (!authoritative) {
      return candidate.status === "launching"
        ? { ...candidate, status: "pending" as const }
        : candidate;
    }
    const isAccessible = authoritative.isAccessible;
    return {
      ...candidate,
      name: authoritative.name,
      description: authoritative.description ?? candidate.description,
      installUrl: authoritative.installUrl ?? candidate.installUrl,
      isAccessible,
      logoUrl: authoritative.logoUrl ?? candidate.logoUrl,
      logoUrlDark: authoritative.logoUrlDark ?? candidate.logoUrlDark,
      status: isAccessible
        ? ("connected" as const)
        : candidate.status === "launching"
          ? ("pending" as const)
          : candidate.status,
    };
  });
}
