// FILE: providerUpdateRail.logic.ts
// Purpose: What the rail's update control shows: which agents one click updates, the status
//          pill's wording, and the icon the button wears. Adapted from T3 Code's sidebar update
//          logic (MIT), reduced to one machine.
// Layer: Web shell navigation (pure logic).

import {
  PROVIDER_DISPLAY_NAMES,
  type DesktopUpdateState,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";

import type { MossLocaleCode } from "~/appSettings";
import type { TranslationKey } from "~/localization";
import { isProviderKind } from "~/providerOrdering";
import { isProviderUpdateActive } from "~/providerUpdates";

export interface ProviderUpdateI18n {
  readonly locale: MossLocaleCode;
  readonly t: (key: TranslationKey) => string;
  readonly format: (key: TranslationKey, values: Record<string, string | number>) => string;
}

export interface ProviderUpdateTarget {
  /** Stable across refreshes: one row per CLI command, not per configured instance. */
  readonly key: string;
  readonly driver: ProviderKind;
  readonly instanceId: ProviderInstanceId | undefined;
  readonly name: string;
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly updateCommand: string | null;
  readonly usesCnMirror: boolean;
  /** Why the last attempt failed, while the agent is still out of date. */
  readonly failureMessage: string | null;
}

export type ProviderUpdatePillTone = "loading" | "warning" | "error" | "success";

export interface ProviderUpdatePillView {
  readonly key: string;
  readonly tone: ProviderUpdatePillTone;
  readonly title: string;
  readonly description: string;
  readonly dismissible?: boolean;
  readonly dismissAfterVisibleMs?: number;
}

export interface ProviderUpdateRunProgress {
  readonly total: number;
  readonly settled: number;
  readonly currentName: string | null;
}

export const PROVIDER_UPDATE_SUCCESS_VISIBLE_MS = 3_000;

function driverOf(provider: ServerProviderStatus): string {
  return provider.driver ?? provider.provider;
}

export function providerStatusDisplayName(provider: ServerProviderStatus): string {
  if (provider.displayName?.trim()) return provider.displayName;
  const driver = driverOf(provider);
  return isProviderKind(driver) ? PROVIDER_DISPLAY_NAMES[driver] : driver;
}

function formatVersion(value: string): string {
  return value.startsWith("v") ? value : `v${value}`;
}

function formatProviderList(
  providers: ReadonlyArray<ServerProviderStatus>,
  locale: MossLocaleCode,
): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    providers.map(providerStatusDisplayName),
  );
}

function isDefaultInstance(provider: ServerProviderStatus): boolean {
  return (provider.instanceId ?? provider.provider) === driverOf(provider);
}

/** Instances that share a CLI share its update, so they collapse onto the default instance. */
export function collectProviderUpdateTargets(
  providers: ReadonlyArray<ServerProviderStatus>,
): ProviderUpdateTarget[] {
  const representatives = new Map<string, ServerProviderStatus>();
  for (const provider of providers) {
    const driver = driverOf(provider);
    if (!isProviderKind(driver)) continue;
    const key = `${driver}\u0000${provider.versionAdvisory?.updateCommand ?? ""}`;
    const current = representatives.get(key);
    if (!current || (isDefaultInstance(provider) && !isDefaultInstance(current))) {
      representatives.set(key, provider);
    }
  }
  return Array.from(representatives, ([key, provider]) => {
    const advisory = provider.versionAdvisory;
    const failed =
      provider.updateState?.status === "failed" || provider.updateState?.status === "unchanged";
    return {
      key,
      driver: driverOf(provider) as ProviderKind,
      instanceId: provider.instanceId,
      name: providerStatusDisplayName(provider),
      currentVersion: advisory?.currentVersion ?? null,
      latestVersion: advisory?.latestVersion ?? null,
      updateCommand: advisory?.updateCommand ?? null,
      usesCnMirror: advisory?.packageChannel === "cn-mirror",
      failureMessage: failed ? (provider.updateState?.message ?? null) : null,
    };
  });
}

function dedupeByDriver(providers: ReadonlyArray<ServerProviderStatus>): ServerProviderStatus[] {
  const byDriver = new Map<string, ServerProviderStatus>();
  for (const provider of providers) {
    const driver = driverOf(provider);
    const current = byDriver.get(driver);
    if (!current || (isDefaultInstance(provider) && !isDefaultInstance(current))) {
      byDriver.set(driver, provider);
    }
  }
  return [...byDriver.values()];
}

function finishedAtOf(provider: ServerProviderStatus): string | null {
  return provider.updateState?.finishedAt ?? null;
}

function isRecentTerminalProvider(
  provider: ServerProviderStatus,
  visibleAfterIso: string | undefined,
): boolean {
  const status = provider.updateState?.status;
  if (status !== "failed" && status !== "unchanged" && status !== "succeeded") return false;
  if (visibleAfterIso === undefined) return true;
  const finishedAt = finishedAtOf(provider);
  return finishedAt !== null && finishedAt >= visibleAfterIso;
}

function latestFinishedAt(providers: ReadonlyArray<ServerProviderStatus>): string {
  return providers.reduce((latest, provider) => {
    const finishedAt = finishedAtOf(provider) ?? "";
    return finishedAt > latest ? finishedAt : latest;
  }, "");
}

/** Use each driver's latest finished instance so an older default-instance result cannot hide it. */
function latestTerminalProvidersByDriver(providers: ReadonlyArray<ServerProviderStatus>) {
  const byDriver = new Map<string, ServerProviderStatus>();
  for (const provider of providers) {
    const driver = driverOf(provider);
    const current = byDriver.get(driver);
    if (!current || (finishedAtOf(provider) ?? "") >= (finishedAtOf(current) ?? "")) {
      byDriver.set(driver, provider);
    }
  }
  return [...byDriver.values()];
}

function terminalKey(prefix: string, providers: ReadonlyArray<ServerProviderStatus>): string {
  const parts = providers
    .map(
      (provider) =>
        `${driverOf(provider)}:${finishedAtOf(provider) ?? "pending"}:${provider.updateState?.message ?? ""}`,
    )
    .toSorted();
  return `${prefix}:${parts.join("|")}`;
}

export function getProviderUpdatePillView(
  providers: ReadonlyArray<ServerProviderStatus>,
  i18n: ProviderUpdateI18n,
  options?: {
    readonly visibleAfterIso?: string;
    readonly dismissedKeys?: ReadonlySet<string>;
    readonly run?: ProviderUpdateRunProgress | null;
  },
): ProviderUpdatePillView | null {
  const { format, locale } = i18n;
  // Filter active instances before deduplicating drivers because update state is per instance.
  const activeProviders = dedupeByDriver(providers.filter(isProviderUpdateActive));
  const run = options?.run ?? null;
  if (activeProviders.length > 0 || run) {
    const activeName = activeProviders[0]
      ? providerStatusDisplayName(activeProviders[0])
      : (run?.currentName ?? null);
    const position = run && run.total > 1 ? `${run.settled + 1}/${run.total}` : null;
    return {
      // One key for the whole phase: queued, running and the next agent only change the wording,
      // and a new key would play the pill's exit in the middle of an update.
      key: "loading",
      tone: "loading",
      title:
        activeProviders.length > 1
          ? format("providerUpdate.pill.updatingMany", { count: activeProviders.length })
          : activeName === null
            ? format("providerUpdate.pill.updatingMany", { count: run?.total ?? 1 })
            : position === null
              ? format("providerUpdate.pill.updating", { name: activeName })
              : format("providerUpdate.pill.updatingStep", { name: activeName, position }),
      description:
        activeProviders.length > 0
          ? format("providerUpdate.pill.updatingDescription", {
              names: formatProviderList(activeProviders, locale),
            })
          : format("providerUpdate.pill.updatingDescription", { names: activeName ?? "" }),
    };
  }

  const recentTerminal = latestTerminalProvidersByDriver(
    providers.filter((provider) => isRecentTerminalProvider(provider, options?.visibleAfterIso)),
  );
  const candidates: Array<{
    readonly view: ProviderUpdatePillView;
    readonly finishedAt: string;
  }> = [];

  const failed = recentTerminal.filter((provider) => provider.updateState?.status === "failed");
  if (failed[0]) {
    const first = failed[0];
    const attempted = first.versionAdvisory?.latestVersion;
    candidates.push({
      finishedAt: latestFinishedAt(failed),
      view: {
        key: terminalKey("failed", failed),
        tone: "error",
        title:
          failed.length > 1
            ? format("providerUpdate.pill.failedMany", { count: failed.length })
            : attempted
              ? format("providerUpdate.pill.failedVersion", {
                  name: providerStatusDisplayName(first),
                  version: formatVersion(attempted),
                })
              : format("providerUpdate.pill.failed", { name: providerStatusDisplayName(first) }),
        description:
          (failed.length === 1 ? first.updateState?.message : null) ??
          format("providerUpdate.pill.failedDescription", {
            names: formatProviderList(failed, locale),
          }),
        dismissible: true,
      },
    });
  }

  const unchanged = recentTerminal.filter(
    (provider) => provider.updateState?.status === "unchanged",
  );
  if (unchanged[0]) {
    candidates.push({
      finishedAt: latestFinishedAt(unchanged),
      view: {
        key: terminalKey("unchanged", unchanged),
        tone: "warning",
        title:
          unchanged.length > 1
            ? format("providerUpdate.pill.unchangedMany", { count: unchanged.length })
            : format("providerUpdate.pill.unchanged", {
                name: providerStatusDisplayName(unchanged[0]),
              }),
        description: format("providerUpdate.pill.unchangedDescription", {
          names: formatProviderList(unchanged, locale),
        }),
        dismissible: true,
      },
    });
  }

  const succeeded = recentTerminal.filter(
    (provider) => provider.updateState?.status === "succeeded",
  );
  if (succeeded[0]) {
    const first = succeeded[0];
    candidates.push({
      finishedAt: latestFinishedAt(succeeded),
      view: {
        key: terminalKey("succeeded", succeeded),
        tone: "success",
        title:
          succeeded.length > 1
            ? format("providerUpdate.pill.updatedMany", { count: succeeded.length })
            : first.version
              ? format("providerUpdate.pill.updatedVersion", {
                  name: providerStatusDisplayName(first),
                  version: formatVersion(first.version),
                })
              : format("providerUpdate.pill.updated", { name: providerStatusDisplayName(first) }),
        description: i18n.t("providerUpdate.pill.updatedDescription"),
        dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
      },
    });
  }

  return (
    candidates
      .toSorted((left, right) => right.finishedAt.localeCompare(left.finishedAt))
      .map(({ view }) => view)
      .find((view) => !options?.dismissedKeys?.has(view.key)) ?? null
  );
}

export type RailUpdatePresentation = "updating" | "update" | "success" | "desktop";

/**
 * One button serves agent updates and the app's own. Agents go first because installing the app
 * restarts Moss, so a ready app update waits until the agents are done.
 */
export function resolveRailUpdatePresentation(input: {
  readonly pillTone: ProviderUpdatePillTone | null;
  readonly targetCount: number;
  readonly desktop: {
    readonly visible: boolean;
    readonly status: DesktopUpdateState["status"] | null;
  };
}): RailUpdatePresentation | null {
  const { pillTone, targetCount, desktop } = input;
  if (pillTone === "loading") return "updating";
  if (desktop.visible && desktop.status === "downloading") return "desktop";
  if (targetCount > 0) return "update";
  if (desktop.visible) return "desktop";
  if (pillTone === "success") return "success";
  return null;
}
