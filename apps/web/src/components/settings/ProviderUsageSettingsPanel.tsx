// FILE: ProviderUsageSettingsPanel.tsx
// Purpose: Settings → Usage panel. One card per supported provider showing live remaining
// quota/credits with linear progress meters, the provider brand icon, and plan/status pills.
// Usage is fetched read-only from each CLI's stored credentials by the server.

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type MossAccountSessionState,
  type MossCloudAccountState,
  type ProviderInstanceId,
  type ServerProviderStatus,
  type ServerProviderUsageSnapshot,
} from "@synara/contracts";
import {
  providerUsageDisplayName,
  providerUsageNeedsAuthDetail,
  selectVisibleProviderUsageSnapshots,
} from "@synara/shared/providerUsage";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { useId, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppSettings, type RailUsageWindow } from "~/appSettings";
import {
  MAX_RAIL_USAGE_ACCOUNTS,
  getRailUsageAccounts,
  resolveRailUsageAccounts,
  toggleRailUsageAccount,
} from "~/components/AppRailUsage.logic";
import { ProviderAccountAvatar } from "~/components/ProviderAccountMark";
import { ProviderIcon } from "~/components/ProviderIcon";
import { ProviderUsageLimitRows } from "~/components/ProviderUsageLimitRows";
import { ProviderUsageLineList } from "~/components/ProviderUsageLineList";
import { ProviderUsageResetCredits } from "~/components/ProviderUsageResetCredits";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { MossLogo } from "~/components/MossLogo";
import { MossBillingSettingsPanel } from "~/components/settings/MossBillingSettingsPanel";
import {
  SettingsCard,
  SettingsListRow,
  SettingsSection,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { SettingsSegmentedControl } from "~/components/settings/SettingControls";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { useProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { RotateCcwIcon, TriangleAlertIcon } from "~/lib/icons";
import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";
import {
  mergeProviderUsageRefresh,
  providerUsageSnapshotInstanceId,
} from "~/lib/providerUsageSnapshot";
import { deriveAccountRateLimits, type ProviderRateLimit } from "~/lib/rateLimits";
import {
  fetchAllProviderUsage,
  serverAllProviderUsageQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";

const RAIL_USAGE_WINDOW_OPTIONS = [
  { value: "both", label: "Both" },
  { value: "fiveHour", label: "5h" },
  { value: "weekly", label: "Weekly" },
] as const satisfies ReadonlyArray<{ value: RailUsageWindow; label: string }>;

const PILL_CLASS_NAME = "shrink-0 rounded-full px-2 py-1 text-ui-sm font-medium leading-none";

interface StatusPill {
  label: string;
  className: string;
}

function statusPill(status: ServerProviderUsageSnapshot["status"]): StatusPill | null {
  switch (status) {
    case "needs-auth":
      return {
        label: "Not signed in",
        className: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
      };
    case "unsupported":
      return { label: "Unsupported", className: "bg-muted text-muted-foreground" };
    case "error":
      return { label: "Unavailable", className: "bg-red-500/12 text-red-600 dark:text-red-400" };
    default:
      return null;
  }
}

export type MossUsageState = "checking" | "ready" | "signed-out" | "unavailable";

export function resolveMossUsageState(input: {
  accountState:
    | Pick<MossCloudAccountState, "authenticated" | "configured" | "modelGatewayConfigured">
    | null
    | undefined;
  phoneState: Pick<MossAccountSessionState, "authenticated" | "configured"> | null | undefined;
  pending: boolean;
  failed: boolean;
}): MossUsageState {
  if (input.phoneState?.authenticated) {
    // Phone and Google accounts are separate authorities. A phone session's
    // readiness is determined by the phone realm's own `configured` flag;
    // consulting the cloud account's modelGatewayConfigured value makes a
    // valid domestic session look unavailable whenever the global realm is
    // intentionally not configured (for example, on a CN-only deployment).
    return input.phoneState.configured ? "ready" : "unavailable";
  }
  if (input.accountState?.authenticated) {
    return input.accountState.modelGatewayConfigured ? "ready" : "unavailable";
  }
  // The phone and cloud queries resolve independently. If neither authority
  // has confirmed an authenticated account yet, keep the surface in its
  // loading state for the entire refresh window. This prevents a cached
  // signed-out result or an intentionally absent cloud realm from turning a
  // valid (but not-yet-known) domestic session into a false outage state.
  if (input.pending) {
    return "checking";
  }
  if (input.failed && !input.accountState && !input.phoneState) {
    return "unavailable";
  }
  if (input.accountState?.configured || input.phoneState?.configured) {
    return "signed-out";
  }
  return "unavailable";
}

export function shouldShowProviderUsageSnapshot(
  snapshot: ServerProviderUsageSnapshot,
  providerStatuses: readonly ServerProviderStatus[],
): boolean {
  const status = snapshot.status ?? "ok";
  if (status === "needs-auth" || status === "unsupported") {
    return false;
  }
  if (status === "ok") {
    return true;
  }
  return providerStatuses.some(
    (providerStatus) =>
      (providerStatus.driver ?? providerStatus.provider) === snapshot.provider &&
      providerStatus.instanceId !== "codex_moss" &&
      providerStatus.displayName?.trim().toLocaleLowerCase() !== "moss" &&
      providerStatus.authStatus === "authenticated",
  );
}

function isPersonalAuthenticatedCodexStatus(status: ServerProviderStatus): boolean {
  const instanceId = status.instanceId ?? status.provider;
  return (
    (status.driver ?? status.provider) === "codex" &&
    instanceId !== "codex_moss" &&
    status.displayName?.trim().toLocaleLowerCase() !== "moss" &&
    status.authStatus === "authenticated" &&
    status.enabled !== false
  );
}

export function resolveCodexUsageProviderInstanceId(input: {
  readonly defaultProviderInstanceId: ProviderInstanceId;
  readonly providerStatuses: readonly ServerProviderStatus[];
}): ProviderInstanceId {
  const selectedPersonal = input.providerStatuses.find(
    (status) =>
      (status.instanceId ?? status.provider) === input.defaultProviderInstanceId &&
      isPersonalAuthenticatedCodexStatus(status),
  );
  if (selectedPersonal) {
    return selectedPersonal.instanceId ?? selectedPersonal.provider;
  }

  const canonicalPersonal = input.providerStatuses.find(
    (status) =>
      (status.instanceId ?? status.provider) === "codex" &&
      isPersonalAuthenticatedCodexStatus(status),
  );
  if (canonicalPersonal) {
    return canonicalPersonal.instanceId ?? canonicalPersonal.provider;
  }

  const anyPersonal = input.providerStatuses.find(isPersonalAuthenticatedCodexStatus);
  if (anyPersonal) {
    return anyPersonal.instanceId ?? anyPersonal.provider;
  }

  return input.defaultProviderInstanceId === "codex_moss"
    ? "codex"
    : input.defaultProviderInstanceId;
}

function MossUsageCard({ state }: { state: MossUsageState }) {
  const providerNameId = useId();
  const statusId = useId();
  const descriptionId = useId();
  if (state === "checking") {
    return <MossUsageSkeletonCard />;
  }
  const presentation = (() => {
    switch (state) {
      case "ready":
        return {
          label: "Available",
          description:
            "Moss is connected and ready to use. No quota data is available to display yet.",
          className: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
        };
      case "signed-out":
        return {
          label: "Not signed in",
          description: "Sign in to Moss to use the included models.",
          className: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
        };
      case "unavailable":
        return {
          label: "Unavailable",
          description: "Moss model service is temporarily unavailable. Try again shortly.",
          className: "bg-red-500/12 text-red-600 dark:text-red-400",
        };
    }
  })();

  return (
    <SettingsCard>
      <div
        className="space-y-3.5 p-4"
        role="group"
        aria-labelledby={providerNameId}
        aria-describedby={`${statusId} ${descriptionId}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border)] bg-muted/60">
              <MossLogo className="size-4" />
            </span>
            <h3 id={providerNameId} className="truncate text-ui-lg font-semibold text-foreground">
              Moss
            </h3>
          </div>
          <span id={statusId} className={cn(PILL_CLASS_NAME, presentation.className)}>
            {presentation.label}
          </span>
        </div>
        <p id={descriptionId} className="text-ui-sm leading-relaxed text-muted-foreground">
          {presentation.description}
        </p>
      </div>
    </SettingsCard>
  );
}

function MossUsageSkeletonCard() {
  return (
    <SettingsCard>
      <div
        aria-busy="true"
        aria-label="Checking your Moss account…"
        className="space-y-3.5 p-4"
        data-testid="moss-usage-skeleton"
        role="status"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border)] bg-muted/60">
              <MossLogo className="size-4" />
            </span>
            <span className="text-ui-lg font-semibold text-foreground">Moss</span>
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-3.5 w-3/4 rounded-full" />
      </div>
    </SettingsCard>
  );
}

function ProviderUsageCard({
  snapshot,
  accountLabel,
  threadRateLimits,
  codexHomePath,
}: {
  snapshot: ServerProviderUsageSnapshot;
  accountLabel: string | null;
  threadRateLimits: ReadonlyArray<ProviderRateLimit>;
  codexHomePath: string | null;
}) {
  const provider = snapshot.provider;
  const providerName = providerUsageDisplayName(provider);
  const providerNameId = useId();
  const statusId = useId();
  const descriptionId = useId();
  const status = snapshot.status ?? "ok";
  const usageSummary = useProviderUsageSummary({
    provider,
    providerInstanceId: providerUsageSnapshotInstanceId(snapshot),
    threadRateLimits,
    codexHomePath,
    providerSnapshot: snapshot,
  });
  const meterRows = deriveProviderUsageDisplayRows(usageSummary.rateLimits);
  const usageLines = usageSummary.usageLines;
  const resetCredits = provider === "codex" ? snapshot.resetCredits : undefined;
  const hasResetCredits = Boolean(resetCredits && resetCredits.availableCount > 0);
  const hasUsage = meterRows.length > 0 || usageLines.length > 0 || hasResetCredits;
  const pill = status === "ok" ? null : statusPill(snapshot.status);
  const hasVisibleStatus = Boolean((status === "ok" && snapshot.planName) || pill);
  const showsStatusDescription = status !== "ok" || !hasUsage;
  const describedBy = [
    hasVisibleStatus ? statusId : null,
    showsStatusDescription ? descriptionId : null,
  ]
    .filter((id): id is string => id !== null)
    .join(" ");

  return (
    <SettingsCard>
      <div
        className="space-y-3.5 p-4"
        role="group"
        aria-labelledby={providerNameId}
        aria-describedby={describedBy || undefined}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border)] bg-muted/60">
              <ProviderIcon provider={provider} className="size-4" />
            </span>
            <div className="min-w-0 space-y-0.5">
              <h3
                id={providerNameId}
                className="block truncate text-ui-lg font-semibold text-foreground"
              >
                {providerName}
              </h3>
              {accountLabel ? (
                <p className="truncate text-ui-sm text-muted-foreground" title={accountLabel}>
                  {accountLabel}
                </p>
              ) : null}
            </div>
          </div>
          {status === "ok" && snapshot.planName ? (
            <span id={statusId} className={cn(PILL_CLASS_NAME, "bg-muted text-muted-foreground")}>
              {snapshot.planName}
            </span>
          ) : pill ? (
            <span id={statusId} className={cn(PILL_CLASS_NAME, pill.className)}>
              {pill.label}
            </span>
          ) : null}
        </div>

        {status === "ok" && hasUsage ? (
          <>
            {usageSummary.usageNotice ? (
              <p className="flex items-start gap-1.5 text-ui leading-relaxed text-amber-600 dark:text-amber-300/90">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{usageSummary.usageNotice}</span>
              </p>
            ) : null}
            {meterRows.length > 0 ? (
              <ProviderUsageLimitRows rows={meterRows} surface="settings" />
            ) : null}
            {hasResetCredits && resetCredits ? (
              <ProviderUsageResetCredits resetCredits={resetCredits} />
            ) : null}
            {usageLines.length > 0 ? (
              <ProviderUsageLineList
                className={cn(
                  (meterRows.length > 0 || hasResetCredits) &&
                    "border-t border-[color:var(--color-border)] pt-3",
                )}
                lines={usageLines}
                surface="settings"
              />
            ) : null}
          </>
        ) : (
          <p id={descriptionId} className="text-ui leading-relaxed text-muted-foreground">
            {status === "ok"
              ? "No usage data reported yet."
              : (snapshot.detail ?? providerUsageNeedsAuthDetail(provider))}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}

export function ProviderUsageSettingsPanel() {
  const queryClient = useQueryClient();
  const { settings, updateSettings } = useAppSettings();
  const codexHomePath = settings.codexHomePath || null;
  const threads = useStore(useMemo(() => createAllThreadsSelector(), []));
  // Account/thread fallback rows are shared by every provider card; derive them once per panel.
  const threadRateLimits = deriveAccountRateLimits(threads);
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const providerInstances = useMemo(
    () =>
      new Map(
        deriveProviderInstances(serverSettingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW).map(
          (instance) => [instance.instanceId, instance],
        ),
      ),
    [serverSettingsQuery.data],
  );
  const railUsageAccounts = getRailUsageAccounts(
    [...providerInstances.values()],
    settings.disabledProviders,
  );
  // Disabled accounts keep their saved choice; only deleted accounts are discarded.
  const savedRailUsageInstanceIds = (
    settings.railUsageInstanceIds ?? settings.railUsageProviders
  ).filter((instanceId) => providerInstances.has(instanceId));
  const railUsageInstanceIds = resolveRailUsageAccounts(
    settings.railUsageInstanceIds ?? settings.railUsageProviders,
    railUsageAccounts,
  ).map((account) => account.instance.instanceId);
  const railUsageFull = railUsageInstanceIds.length >= MAX_RAIL_USAGE_ACCOUNTS;
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const mossPhoneQuery = useQuery(serverMossAccountSessionQueryOptions());
  const mossAccountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const refreshMutation = useMutation({
    mutationFn: () => fetchAllProviderUsage({ forceRefresh: true }),
    onSuccess: (data) => {
      queryClient.setQueryData<readonly ServerProviderUsageSnapshot[]>(
        serverQueryKeys.allProviderUsage(),
        (previous) => mergeProviderUsageRefresh(previous, data),
      );
    },
  });

  // Use the live payload only. Inventing error placeholders for omitted providers
  // would count as "connected" and hide unsigned cards.
  // Loaded settings remove stale cached accounts immediately while a fresh
  // batch is still in flight. Keep cached usage visible until settings arrive.
  // Moss semantics: a default instance (id identical to its driver, e.g. codex)
  // follows providers.<driver>.enabled; named instances follow
  // providerInstances[id].enabled — deriveProviderInstances encodes both.
  const activeSnapshots = serverSettingsQuery.data
    ? (usageQuery.data ?? []).filter((snapshot) => {
        const instance = providerInstances.get(providerUsageSnapshotInstanceId(snapshot));
        return instance?.enabled === true && instance.driver === snapshot.provider;
      })
    : (usageQuery.data ?? []);
  const cards = selectVisibleProviderUsageSnapshots(
    activeSnapshots.filter((snapshot) => !settings.disabledProviders.includes(snapshot.provider)),
  );

  const showInitialLoading = usageQuery.isPending && !usageQuery.data;

  const isRefreshing = usageQuery.isFetching || refreshMutation.isPending;

  const mossUsageState = resolveMossUsageState({
    accountState: mossAccountQuery.data,
    phoneState: mossPhoneQuery.data,
    pending:
      mossAccountQuery.isPending ||
      mossAccountQuery.isFetching ||
      mossPhoneQuery.isPending ||
      mossPhoneQuery.isFetching,
    failed: mossAccountQuery.isError && mossPhoneQuery.isError,
  });

  return (
    <>
      {mossUsageState === "ready" ? (
        <MossBillingSettingsPanel />
      ) : (
        <SettingsSection title="Moss">
          <MossUsageCard state={mossUsageState} />
        </SettingsSection>
      )}
      <SettingsSection title={`Sidebar · up to ${MAX_RAIL_USAGE_ACCOUNTS} accounts`}>
        {railUsageAccounts.map(({ instance, label }) => {
          const checked = railUsageInstanceIds.includes(instance.instanceId);
          return (
            <SettingsListRow
              key={instance.instanceId}
              title={
                <span className="flex items-center gap-2">
                  <ProviderAccountAvatar
                    provider={instance.driver}
                    accentColor={instance.raw.accentColor}
                    className="size-6"
                  />
                  <span className="truncate">{label}</span>
                </span>
              }
              actions={
                <Switch
                  checked={checked}
                  disabled={serverSettingsQuery.isPending || (!checked && railUsageFull)}
                  onCheckedChange={(next) =>
                    updateSettings({
                      railUsageInstanceIds: toggleRailUsageAccount(
                        savedRailUsageInstanceIds,
                        instance.instanceId,
                        Boolean(next),
                        railUsageAccounts,
                      ),
                    })
                  }
                  aria-label={`Show ${label} usage at the bottom of the sidebar`}
                />
              }
            />
          );
        })}
        <SettingsListRow
          title="Ring"
          description="Show both limits as two rings, or a single ring for one of them."
          actions={
            <SettingsSegmentedControl
              value={settings.railUsageWindow}
              onValueChange={(value) => updateSettings({ railUsageWindow: value })}
              ariaLabel="Sidebar usage ring"
              options={RAIL_USAGE_WINDOW_OPTIONS}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Usage popovers">
        <SettingsListRow
          title="Show details by default"
          description="Open the details below the limits. When off, they stay behind the Details toggle; your last toggle also updates this preference."
          actions={
            <Switch
              checked={settings.usageDetailsDefaultOpen}
              onCheckedChange={(next) => updateSettings({ usageDetailsDefaultOpen: Boolean(next) })}
              aria-label="Show usage details by default in usage popovers"
            />
          }
        />
        {!settings.disabledProviders.includes("codex") ? (
          <SettingsListRow
            title="Banked resets"
            description="Include Codex banked resets in the details."
            actions={
              <Switch
                checked={settings.usagePopoverShowResetCredits}
                onCheckedChange={(next) =>
                  updateSettings({ usagePopoverShowResetCredits: Boolean(next) })
                }
                aria-label="Show banked resets in usage popovers"
              />
            }
          />
        ) : null}
        <SettingsListRow
          title="Credits and token totals"
          description="Include credit balances and recent token totals (24h, 7d, 30d) in the details."
          actions={
            <Switch
              checked={settings.usagePopoverShowUsageLines}
              onCheckedChange={(next) =>
                updateSettings({ usagePopoverShowUsageLines: Boolean(next) })
              }
              aria-label="Show credits and token totals in usage popovers"
            />
          }
        />
      </SettingsSection>
      <SettingsSectionShell
        title="Provider usage"
        action={
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={isRefreshing}
            onClick={() => refreshMutation.mutate()}
          >
            <RotateCcwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
            Refresh
          </Button>
        }
      >
        {showInitialLoading ? (
          <SettingsCard>
            <div className="px-4 py-3.5 text-ui leading-snug text-muted-foreground">
              Loading provider usage…
            </div>
          </SettingsCard>
        ) : (
          <div className="flex flex-col gap-3">
            {cards.map((snapshot) => {
              const instanceId = providerUsageSnapshotInstanceId(snapshot);
              const instance = providerInstances.get(instanceId);
              const accountLabel =
                instanceId !== snapshot.provider
                  ? (instance?.displayName ?? instanceId)
                  : instance?.raw.displayName?.trim() ||
                    (snapshot.providerInstanceId || snapshot.instanceId ? "Default account" : null);
              return (
                <ProviderUsageCard
                  key={instanceId}
                  snapshot={snapshot}
                  accountLabel={accountLabel}
                  threadRateLimits={threadRateLimits}
                  codexHomePath={codexHomePath}
                />
              );
            })}
          </div>
        )}

        <p className="px-2 text-ui-sm leading-relaxed text-muted-foreground">
          Usage is read locally from each provider CLI&apos;s stored credentials and fetched
          directly from the provider. The list follows whatever you are signed into; unsigned
          providers stay visible until any account is connected, then drop away. Short-lived tokens
          are refreshed through the provider&apos;s own CLI or official token endpoint.
        </p>
      </SettingsSectionShell>
    </>
  );
}
