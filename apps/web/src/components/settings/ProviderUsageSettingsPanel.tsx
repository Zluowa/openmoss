// FILE: ProviderUsageSettingsPanel.tsx
// Purpose: Settings → Usage & limits Overview tab. Organizes Moss cloud plan & quota,
//          7d/30d usage trends & product breakdown, user's own Codex/Claude CLI limits
//          (clearly separated from Moss cloud quota), and sidebar/popover display preferences.
// Layer: Settings UI components
// Exports: ProviderUsageSettingsPanel, resolveMossUsageState, shouldShowProviderUsageSnapshot,
//          resolveCodexUsageProviderInstanceId, MossUsageState

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type MossAccountSessionState,
  type MossCloudAccountState,
  type ProviderInstanceId,
  type ServerProviderStatus,
  type ServerProviderUsageSnapshot,
} from "@moss/contracts";
import {
  providerUsageDisplayName,
  providerUsageNeedsAuthDetail,
  selectVisibleProviderUsageSnapshots,
} from "@moss/shared/providerUsage";
import { deriveProviderInstances } from "@moss/shared/providerInstances";
import { useId, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { appHistory } from "~/appNavigation";
import { useAppSettings, type RailUsageWindow } from "~/appSettings";
import {
  getRailUsageAccounts,
  MOSS_RAIL_USAGE_ID,
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
import { useTranslation } from "~/localization";
import { MossBillingSettingsPanel } from "~/components/settings/MossBillingSettingsPanel";
import {
  SettingsCard,
  SettingsListRow,
  SettingsSection,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { SettingsSegmentedControl } from "~/components/settings/SettingControls";
import { UsageOverviewActivitySection } from "~/components/settings/UsageOverviewActivitySection";
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
import { closeSettings } from "~/settingsDialogStore";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";

const PILL_CLASS_NAME = "shrink-0 rounded-full px-2 py-1 text-ui-xs font-medium leading-none";

interface StatusPill {
  label: string;
  className: string;
}

function statusPill(
  status: ServerProviderUsageSnapshot["status"],
  t: ReturnType<typeof useTranslation>["t"],
): StatusPill | null {
  switch (status) {
    case "needs-auth":
      return {
        label: t("settings.usage.status.notSignedIn"),
        className: "bg-warning/12 text-warning-foreground",
      };
    case "unsupported":
      return {
        label: t("settings.usage.status.unsupported"),
        className: "bg-foreground/[0.06] text-muted-foreground",
      };
    case "error":
      return {
        label: t("settings.usage.status.unavailable"),
        className: "bg-destructive/12 text-destructive",
      };
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

function MossUsageCard({
  state,
  onRetry,
}: {
  readonly state: MossUsageState;
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation();
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
          label: t("settings.usage.status.available"),
          description: t("settings.usage.moss.ready"),
          className: "bg-success/12 text-success-foreground",
        };
      case "signed-out":
        return {
          label: t("settings.usage.status.notSignedIn"),
          description: t("settings.usage.moss.signedOut"),
          className: "bg-warning/12 text-warning-foreground",
        };
      case "unavailable":
        return {
          label: t("settings.usage.status.unavailable"),
          description: t("settings.usage.moss.unavailable"),
          className: "bg-destructive/12 text-destructive",
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-control border border-[color:var(--color-border)] bg-foreground/[0.03]">
              <MossLogo className="size-4" />
            </span>
            <h3 id={providerNameId} className="truncate text-ui-lg font-medium text-foreground">
              Moss
            </h3>
          </div>
          <span id={statusId} className={cn(PILL_CLASS_NAME, presentation.className)}>
            {presentation.label}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            id={descriptionId}
            className="min-w-0 flex-1 text-ui-sm leading-relaxed text-muted-foreground"
          >
            {presentation.description}
          </p>
          {state === "signed-out" ? (
            <Button
              data-testid="moss-usage-sign-in"
              onClick={() => {
                closeSettings();
                appHistory.push("/login");
              }}
              size="sm"
              variant="default"
            >
              {t("settings.usage.moss.signInAction")}
            </Button>
          ) : state === "unavailable" ? (
            <Button data-testid="moss-usage-retry" onClick={onRetry} size="sm" variant="outline">
              {t("settings.usage.moss.retryAction")}
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsCard>
  );
}

function MossUsageSkeletonCard() {
  const { t } = useTranslation();
  return (
    <SettingsCard>
      <div
        aria-busy="true"
        aria-label={t("settings.usage.moss.checking")}
        className="space-y-3.5 p-4"
        data-testid="moss-usage-skeleton"
        role="status"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-control border border-[color:var(--color-border)] bg-foreground/[0.03]">
              <MossLogo className="size-4" />
            </span>
            <span className="text-ui-lg font-medium text-foreground">Moss</span>
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
  const { t } = useTranslation();
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
  const pill = status === "ok" ? null : statusPill(snapshot.status, t);
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
            <span className="flex size-7 shrink-0 items-center justify-center rounded-control border border-[color:var(--color-border)] bg-foreground/[0.03]">
              <ProviderIcon provider={provider} className="size-4" />
            </span>
            <div className="min-w-0 space-y-0.5">
              <h3
                id={providerNameId}
                className="block truncate text-ui-lg font-medium text-foreground"
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
            <span
              id={statusId}
              className={cn(PILL_CLASS_NAME, "bg-foreground/[0.06] text-muted-foreground")}
            >
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
              <p className="flex items-start gap-1.5 text-ui leading-relaxed text-warning-foreground">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
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
          <p id={descriptionId} className="text-ui-sm leading-relaxed text-muted-foreground">
            {status === "ok"
              ? t("settings.usage.noData")
              : (snapshot.detail ?? providerUsageNeedsAuthDetail(provider))}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}

export function ProviderUsageSettingsPanel({
  onOpenAnalytics,
}: {
  readonly onOpenAnalytics?: (() => void) | undefined;
} = {}) {
  const { format, t } = useTranslation();
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
    t("chat.modelPicker.source.local"),
  );
  // Disabled accounts keep their saved choice; only deleted accounts are discarded.
  const savedRailUsageInstanceIds = (
    settings.railUsageInstanceIds ?? settings.railUsageProviders
  ).filter((instanceId) => instanceId === MOSS_RAIL_USAGE_ID || providerInstances.has(instanceId));
  const mossRingChecked = savedRailUsageInstanceIds.includes(MOSS_RAIL_USAGE_ID);
  const railUsageInstanceIds = resolveRailUsageAccounts(
    settings.railUsageInstanceIds ?? settings.railUsageProviders,
    railUsageAccounts,
  ).map((account) => account.instance.instanceId);
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

  const railUsageWindowOptions = useMemo(
    () =>
      [
        { value: "both", label: t("settings.usage.rings.windowBoth") },
        { value: "fiveHour", label: t("settings.usage.rings.windowFiveHour") },
        { value: "weekly", label: t("settings.usage.rings.windowWeekly") },
      ] as const satisfies ReadonlyArray<{ value: RailUsageWindow; label: string }>,
    [t],
  );

  const retryMossStatus = () => {
    void mossPhoneQuery.refetch();
    void mossAccountQuery.refetch();
  };

  return (
    <div className="flex flex-col gap-8">
      {/* 1. Moss cloud plan & quota */}
      <div className="space-y-2" data-testid="usage-moss-cloud-section">
        {mossUsageState === "ready" ? (
          <MossBillingSettingsPanel />
        ) : (
          <SettingsSection title="Moss">
            <MossUsageCard onRetry={retryMossStatus} state={mossUsageState} />
          </SettingsSection>
        )}
      </div>

      {/* 2. 7d / 30d activity chart & per-product / model breakdown */}
      <UsageOverviewActivitySection onOpenAnalytics={onOpenAnalytics} />

      {/* 3. Personal CLI accounts' own limits — visually separated from Moss cloud quota */}
      <div
        className="border-t border-[color:var(--color-border)] pt-6"
        data-testid="usage-personal-cli-section"
      >
        <SettingsSectionShell
          title={t("settings.usage.personal.title")}
          action={
            <Button
              size="xs"
              variant="outline"
              className="shrink-0"
              disabled={isRefreshing}
              onClick={() => refreshMutation.mutate()}
            >
              <RotateCcwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
              {t("settings.usage.refresh")}
            </Button>
          }
        >
          <p className="-mt-1 px-2 text-ui-sm leading-relaxed text-muted-foreground">
            {t("settings.usage.personal.subtitle")}
          </p>
          {showInitialLoading ? (
            <SettingsCard>
              <div className="px-4 py-3.5 text-ui leading-snug text-muted-foreground">
                {t("settings.usage.loading")}
              </div>
            </SettingsCard>
          ) : cards.length === 0 ? (
            <SettingsCard divided={false}>
              <div className="space-y-1 px-4 py-4" data-testid="usage-personal-cli-empty">
                <p className="text-ui font-medium text-foreground">
                  {t("settings.usage.personal.emptyTitle")}
                </p>
                <p className="text-ui-sm text-muted-foreground">
                  {t("settings.usage.personal.emptyDescription")}
                </p>
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
                      (snapshot.providerInstanceId || snapshot.instanceId
                        ? t("settings.usage.personal.defaultAccount")
                        : null);
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
        </SettingsSectionShell>
      </div>

      {/* 4. Sidebar usage rings & popover display preferences */}
      <div className="space-y-6 border-t border-[color:var(--color-border)] pt-6">
        <SettingsSection title={t("settings.usage.rings.title")}>
          <SettingsListRow
            title={
              <span className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center">
                  <MossLogo className="size-4" />
                </span>
                <span className="truncate">Moss</span>
              </span>
            }
            actions={
              <Switch
                checked={mossRingChecked}
                onCheckedChange={(next) =>
                  updateSettings({
                    railUsageInstanceIds: toggleRailUsageAccount(
                      savedRailUsageInstanceIds,
                      MOSS_RAIL_USAGE_ID,
                      Boolean(next),
                    ),
                  })
                }
                aria-label={format("settings.usage.rings.toggleAria", { name: "Moss" })}
              />
            }
          />
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
                    disabled={serverSettingsQuery.isPending}
                    onCheckedChange={(next) =>
                      updateSettings({
                        railUsageInstanceIds: toggleRailUsageAccount(
                          savedRailUsageInstanceIds,
                          instance.instanceId,
                          Boolean(next),
                        ),
                      })
                    }
                    aria-label={format("settings.usage.rings.toggleAria", { name: label })}
                  />
                }
              />
            );
          })}
          <SettingsListRow
            title={t("settings.usage.rings.ringLabel")}
            description={t("settings.usage.rings.ringDescription")}
            actions={
              <SettingsSegmentedControl
                value={settings.railUsageWindow}
                onValueChange={(value) => updateSettings({ railUsageWindow: value })}
                ariaLabel={t("settings.usage.rings.title")}
                options={railUsageWindowOptions}
              />
            }
          />
        </SettingsSection>

        <SettingsSection title={t("settings.usage.popovers.title")}>
          <SettingsListRow
            title={t("settings.usage.popovers.detailsTitle")}
            description={t("settings.usage.popovers.detailsDescription")}
            actions={
              <Switch
                checked={settings.usageDetailsDefaultOpen}
                onCheckedChange={(next) =>
                  updateSettings({ usageDetailsDefaultOpen: Boolean(next) })
                }
                aria-label={t("settings.usage.popovers.detailsTitle")}
              />
            }
          />
          {!settings.disabledProviders.includes("codex") ? (
            <SettingsListRow
              title={t("settings.usage.popovers.bankedResetsTitle")}
              description={t("settings.usage.popovers.bankedResetsDescription")}
              actions={
                <Switch
                  checked={settings.usagePopoverShowResetCredits}
                  onCheckedChange={(next) =>
                    updateSettings({ usagePopoverShowResetCredits: Boolean(next) })
                  }
                  aria-label={t("settings.usage.popovers.bankedResetsTitle")}
                />
              }
            />
          ) : null}
          <SettingsListRow
            title={t("settings.usage.popovers.creditsTokensTitle")}
            description={t("settings.usage.popovers.creditsTokensDescription")}
            actions={
              <Switch
                checked={settings.usagePopoverShowUsageLines}
                onCheckedChange={(next) =>
                  updateSettings({ usagePopoverShowUsageLines: Boolean(next) })
                }
                aria-label={t("settings.usage.popovers.creditsTokensTitle")}
              />
            }
          />
        </SettingsSection>
      </div>
    </div>
  );
}
