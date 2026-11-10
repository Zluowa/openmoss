// FILE: providerUpdates.ts
// Purpose: Shared provider-update filtering and refresh cadence for global toasts and settings.
// Layer: Web settings/notification utility
// Exports: update candidate helpers, notification keys, and auto-refresh timing.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerSettings,
  isSupportedProviderKind,
} from "@moss/contracts";
import { isProviderKind } from "./providerOrdering";

export const PROVIDER_UPDATE_INITIAL_REFRESH_DELAY_MS = 10_000;
export const PROVIDER_UPDATE_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
// The server stops provider commands after five minutes. This slightly longer
// client watchdog also covers a stalled transport so loading UI always settles.
export const PROVIDER_UPDATE_REQUEST_TIMEOUT_MS = 5 * 60_000 + 15_000;

function formatUpdateTimeout(timeoutMs: number): string {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const seconds = timeoutMs / 1_000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

export async function withProviderUpdateTimeout<T>(input: {
  readonly provider: ProviderKind;
  readonly request: Promise<T>;
  readonly timeoutMs?: number;
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? PROVIDER_UPDATE_REQUEST_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `${PROVIDER_DISPLAY_NAMES[input.provider]} update timed out after ${formatUpdateTimeout(timeoutMs)}.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([input.request, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

type ProviderUpdateFilterInput = {
  readonly providers: ReadonlyArray<ServerProviderStatus>;
  readonly hiddenProviders?: ReadonlyArray<ProviderKind>;
  readonly serverSettings?:
    | Pick<ServerSettings, "providers" | "providerInstances" | "enableProviderUpdateChecks">
    | null
    | undefined;
  readonly oneClickOnly?: boolean;
};

type ProviderUpdateVisibilityInput = {
  readonly provider: ServerProviderStatus;
  readonly hiddenProviders?: ReadonlyArray<ProviderKind>;
  readonly hiddenProviderSet?: ReadonlySet<ProviderKind>;
  readonly serverSettings?:
    | Pick<ServerSettings, "providers" | "providerInstances" | "enableProviderUpdateChecks">
    | null
    | undefined;
  readonly oneClickOnly?: boolean;
};

export function isProviderUpdateActive(provider: ServerProviderStatus): boolean {
  return provider.updateState?.status === "queued" || provider.updateState?.status === "running";
}

// A provider whose latest version Moss cannot look up (self-updating CLIs such as
// `cursor-agent`) is permanently "unknown". Treating that as an update prompt made its
// row nag forever, so those providers get the update offered as a manual action instead.
export function isProviderLatestVersionKnowable(provider: ServerProviderStatus): boolean {
  return provider.versionAdvisory?.latestVersionKnowable !== false;
}

// Only Codex and Claude share one program across accounts. Its default account
// may have no private configuration while an enabled account ran the real CLI.
export function installedProgramStatus(
  provider: ProviderKind,
  defaultStatus: ServerProviderStatus | undefined,
  statuses: ReadonlyArray<ServerProviderStatus>,
): ServerProviderStatus | undefined {
  if (
    (provider !== "codex" && provider !== "claudeAgent") ||
    (defaultStatus?.available && defaultStatus.version)
  ) {
    return defaultStatus;
  }
  return (
    statuses.find(
      (status) =>
        (status.driver ?? status.provider) === provider &&
        status.enabled !== false &&
        status.available &&
        status.version,
    ) ?? defaultStatus
  );
}

export function installedVersionLabel(
  provider: ServerProviderStatus,
  checksEnabled: boolean,
): string | null {
  if (!provider.version?.trim()) return null;
  const value = provider.version.trim();
  const version = value.startsWith("v") ? value : `v${value}`;
  const advisory = provider.versionAdvisory;
  if (!checksEnabled) return `Installed ${version} · Update checks off`;
  if (advisory?.status === "current") return `Current ${version}`;
  if (advisory?.status === "unknown" && advisory.latestVersionKnowable === true) {
    return `Installed ${version} · Latest version unavailable`;
  }
  if (advisory?.status === "unknown" && advisory.latestVersionKnowable === false) {
    return `Installed ${version} · Version lookup not supported`;
  }
  return `Installed ${version}`;
}

export function providerVersionCheckSummary(
  input: ProviderUpdateFilterInput & { readonly outdatedCount: number },
): string {
  if (input.serverSettings?.enableProviderUpdateChecks === false) return "Automatic checks off";
  if (input.outdatedCount > 0)
    return `${input.outdatedCount} ${input.outdatedCount === 1 ? "update" : "updates"} available`;
  const installed = input.providers.filter(
    (status) =>
      status.available &&
      status.version &&
      status.enabled !== false &&
      !input.hiddenProviders?.includes((status.driver ?? status.provider) as ProviderKind) &&
      isProviderEnabled(status, input.serverSettings),
  );
  if (
    installed.some(
      (s) =>
        s.versionAdvisory?.status === "unknown" && s.versionAdvisory.latestVersionKnowable === true,
    )
  ) {
    return "Latest version unavailable for some tools";
  }
  if (installed.some((s) => s.versionAdvisory?.status === "current"))
    return "No provider updates detected";
  if (
    installed.length &&
    installed.every((s) => s.versionAdvisory?.latestVersionKnowable === false)
  ) {
    return "Version lookup not supported for installed tools";
  }
  return "No version checks completed";
}

export function shouldOfferProviderUpdateAction(provider: ServerProviderStatus): boolean {
  const advisory = provider.versionAdvisory;
  return (
    advisory?.canUpdate === true &&
    advisory.currentVersion !== null &&
    advisory.updateCommand !== null &&
    (advisory.status === "behind_latest" || advisory.status === "unknown")
  );
}

// Header affordance: reserved for providers Moss can actually assert are outdated.
export function shouldPromptProviderUpdate(provider: ServerProviderStatus): boolean {
  return shouldOfferProviderUpdateAction(provider) && isProviderLatestVersionKnowable(provider);
}

function isProviderEnabled(
  provider: ServerProviderStatus,
  serverSettings: Pick<ServerSettings, "providers" | "providerInstances"> | null | undefined,
): boolean {
  if (!serverSettings) {
    return false;
  }
  const driver = provider.driver ?? provider.provider;
  if (!isProviderKind(driver) || !isSupportedProviderKind(driver)) {
    return false;
  }
  if (serverSettings.providers[driver]?.enabled === false) {
    return false;
  }
  const instanceId = provider.instanceId ?? provider.provider;
  const instance = serverSettings.providerInstances[instanceId];
  if (instance) {
    const config = instance.config;
    const configEnabled =
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>).enabled
        : undefined;
    return instance.enabled !== false && configEnabled !== false;
  }
  return true;
}

// Central visibility gate used by both global toasts and Settings update rows.
export function shouldShowProviderUpdateStatus(input: ProviderUpdateVisibilityInput): boolean {
  const advisory = input.provider.versionAdvisory;
  const hiddenProviderSet = input.hiddenProviderSet ?? new Set(input.hiddenProviders ?? []);
  const driver = input.provider.driver ?? input.provider.provider;
  if (
    !advisory ||
    input.serverSettings?.enableProviderUpdateChecks === false ||
    advisory.status !== "behind_latest" ||
    advisory.latestVersion === null ||
    !isProviderKind(driver) ||
    hiddenProviderSet.has(driver) ||
    !isProviderEnabled(input.provider, input.serverSettings)
  ) {
    return false;
  }

  return input.oneClickOnly === true
    ? advisory.canUpdate === true && advisory.updateCommand !== null
    : true;
}

export function getVisibleProviderUpdateStatuses(
  input: ProviderUpdateFilterInput,
): ServerProviderStatus[] {
  const hiddenProviderSet = new Set(input.hiddenProviders ?? []);
  const oneClickOnly = input.oneClickOnly ?? false;

  return input.providers.filter((provider) =>
    shouldShowProviderUpdateStatus({
      provider,
      serverSettings: input.serverSettings,
      hiddenProviderSet,
      oneClickOnly,
    }),
  );
}

export function getNotifiableProviderUpdateStatuses(
  input: ProviderUpdateFilterInput & { readonly liveVersionCheckCompleted: boolean },
): ServerProviderStatus[] {
  if (!input.liveVersionCheckCompleted) {
    return [];
  }
  return getVisibleProviderUpdateStatuses({ ...input, oneClickOnly: true });
}

export function providerUpdateNotificationKey(
  providers: ReadonlyArray<ServerProviderStatus>,
): string | null {
  const parts = providers
    .map((provider) =>
      [
        provider.instanceId ?? provider.provider,
        provider.versionAdvisory?.latestVersion ?? "unknown",
      ].join(":"),
    )
    .toSorted();

  return parts.length > 0 ? parts.join("|") : null;
}
