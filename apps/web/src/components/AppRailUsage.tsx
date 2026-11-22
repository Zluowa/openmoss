// FILE: AppRailUsage.tsx
// Purpose: Provider usage rings at the bottom of the app rail, above Help: the provider glyph inside a
//          remaining-quota ring, a click popover with balance/quota details and a Manage usage action.
// Layer: App shell component
// Depends on: the shared provider-usage and Moss quota models, so the rail reads the
//             same numbers as the Environment panel and Settings → Usage.

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@moss/contracts";
import { deriveProviderInstances } from "@moss/shared/providerInstances";
import { useQuery } from "@tanstack/react-query";
import { useState, type ComponentProps, type ReactNode } from "react";

import { useAppSettings, type RailUsageWindow } from "~/appSettings";
import { providerUsageSnapshotInstanceId } from "~/lib/providerUsageSnapshot";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { appRailButtonClassName } from "./AppRail";
import {
  MOSS_RAIL_USAGE_ID,
  railUsageRingTone,
  getRailUsageAccounts,
  resolveRailUsageAccounts,
  selectRailUsageRows,
  type RailUsageAccount,
  type RailUsageRingTone,
} from "./AppRailUsage.logic";
import { formatMossPayCount } from "./auth/MossPayPanel";
import { serverMossPayCatalogQueryOptions } from "./auth/mossServerReactQuery";
import { useMossPayQuotaQuery } from "./auth/useMossPayQuotaQuery";
import { useMossQuotaSummary } from "./auth/useMossQuotaSummary";
import { resolveEnvironmentProviderUsageSummary } from "./chat/environment/EnvironmentUsageSection.logic";
import { MossLogo } from "./MossLogo";
import { ProviderAccountDot } from "./ProviderAccountMark";
import { ProviderIcon } from "./ProviderIcon";
import { useProviderUsageMenuModel } from "./ProviderUsageMenuControl";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";
import {
  isBuiltInFreeMossPlanCode,
  mossQuotaRemainingPercent,
  resolveMossPlanPresentation,
  usageWindowLabel,
} from "./settings/MossBillingSettingsPanel";
import { formatMossResetCountdown } from "./settings/mossUsagePresentation.logic";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { StatusChip } from "./ui/status-chip";

// Every ring uses the same scale, so its colour alone says how much is left.
const RING_TONE_CLASS_NAME: Record<RailUsageRingTone, { stroke: string; dot: string }> = {
  healthy: { stroke: "stroke-emerald-500", dot: "bg-emerald-500" },
  fair: { stroke: "stroke-yellow-500", dot: "bg-yellow-500" },
  low: { stroke: "stroke-orange-500", dot: "bg-orange-500" },
  critical: { stroke: "stroke-red-500", dot: "bg-red-500" },
};

// Geometry in px inside the rail's 32px button. Two tracks take a larger box, thinner
// strokes and a smaller glyph, so the tracks keep a 2.25px gap and the glyph clears the
// inner one.
const SINGLE_RING = {
  size: 28,
  stroke: 2.5,
  spacing: 4.5,
  svgClassName: "size-7",
  iconClassName: "size-4",
};
const DOUBLE_RING = {
  size: 34,
  stroke: 2.25,
  spacing: 4.5,
  svgClassName: "size-8.5",
  iconClassName: "size-3",
};
// With more than two accounts every ring steps down to a 28px button so the stack stays
// short; past COMPACT_VISIBLE_RINGS the stack scrolls instead of pushing into Help/account.
const COMPACT_SINGLE_RING = {
  size: 24,
  stroke: 2.25,
  spacing: 4,
  svgClassName: "size-6",
  iconClassName: "size-3.5",
};
const COMPACT_DOUBLE_RING = {
  size: 28,
  stroke: 2,
  spacing: 4,
  svgClassName: "size-7",
  iconClassName: "size-2.5",
};
/** Up to this many accounts keep the full-size rings. */
export const RAIL_USAGE_FULL_SIZE_RINGS = 2;

const RAIL_USAGE_POPOVER_CLASS_NAME =
  "min-w-60 max-w-[min(20rem,calc(100vw-4rem))] rounded-popover border-[0.5px] border-border bg-[color-mix(in_srgb,var(--color-background-elevated-primary-opaque)_94%,transparent)] p-0 shadow-lg backdrop-blur-xl before:hidden [&_[data-slot=popover-viewport]]:p-0";

function RailUsagePopoverShell({
  sourceLabel,
  manageLabel,
  onManageUsage,
  children,
}: {
  readonly sourceLabel: string;
  readonly manageLabel: string;
  readonly onManageUsage: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col text-ui">
      <div className="px-3.5 py-2.5 text-ui-xs text-muted-foreground">{sourceLabel}</div>
      <div className="h-px bg-border/70" aria-hidden="true" />
      <div className="space-y-2 px-3.5 py-2.5">{children}</div>
      <div className="h-px bg-border/70" aria-hidden="true" />
      <div className="p-1.5">
        <Button
          type="button"
          variant="ghost"
          onClick={onManageUsage}
          className="min-h-8 w-full justify-start rounded-control px-2 py-1 text-left text-ui font-normal text-foreground"
        >
          {manageLabel}
        </Button>
      </div>
    </div>
  );
}

/** The rail button a ring sits in; the popover trigger renders through it. */
function RailUsageRingButton({
  ariaLabel,
  compact,
  ...rest
}: Omit<ComponentProps<"button">, "aria-label" | "className" | "type"> & {
  ariaLabel: string;
  compact: boolean;
  "data-rail-usage-moss"?: string;
}) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={ariaLabel}
      className={cn(
        appRailButtonClassName(false),
        "relative flex shrink-0 cursor-pointer items-center justify-center",
        compact && "size-7",
      )}
    />
  );
}

function AppRailUsageRing({
  account,
  snapshot,
  window,
  compact,
  onOpenUsageSettings,
}: {
  account: RailUsageAccount;
  snapshot: ServerProviderUsageSnapshot | undefined;
  window: RailUsageWindow;
  compact: boolean;
  onOpenUsageSettings: () => void;
}) {
  const { format, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { instance, label } = account;
  const provider = instance.driver;
  const model = useProviderUsageMenuModel(provider, {
    instanceId: instance.instanceId,
    providerSnapshot: snapshot ?? null,
  });

  // A failed fetch keeps a dimmed, empty ring (its card says why) so a chosen provider does
  // not vanish on a network blip. Otherwise nothing displayable (still loading, signed out,
  // or no usage source) means no ring.
  const unavailable = snapshot?.status === "error";
  if (!unavailable && model.rows.length === 0 && model.usageLines.length === 0) {
    return null;
  }

  const summary = resolveEnvironmentProviderUsageSummary({
    providerName: label,
    rows: model.rows,
    snapshot,
    hasUsageLines: model.usageLines.length > 0,
  });
  const rings = selectRailUsageRows(model.rows, model.primaryRow, window).map((row) => ({
    row,
    tone: RING_TONE_CLASS_NAME[railUsageRingTone(row.remainingPercent)],
  }));
  const ring = compact
    ? rings.length > 1
      ? COMPACT_DOUBLE_RING
      : COMPACT_SINGLE_RING
    : rings.length > 1
      ? DOUBLE_RING
      : SINGLE_RING;
  const outerRadius = (ring.size - ring.stroke) / 2;
  const sourceName = snapshot?.planName ? `${label} · ${snapshot.planName}` : label;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <RailUsageRingButton
            ariaLabel={`${summary.ariaLabel}. ${t("sidebar.railUsage.open")}`}
            compact={compact}
            title={summary.ariaLabel}
          />
        }
      >
        <svg
          viewBox={`0 0 ${ring.size} ${ring.size}`}
          className={cn("-rotate-90", ring.svgClassName)}
          fill="none"
          aria-hidden
        >
          {rings.length === 0 ? (
            <circle
              cx={ring.size / 2}
              cy={ring.size / 2}
              r={outerRadius}
              strokeWidth={ring.stroke}
              className="stroke-current opacity-15"
            />
          ) : null}
          {rings.map(({ row, tone }, index) => (
            <g key={row.id}>
              <circle
                cx={ring.size / 2}
                cy={ring.size / 2}
                r={outerRadius - index * ring.spacing}
                strokeWidth={ring.stroke}
                className="stroke-current opacity-15"
              />
              {row.remainingPercent > 0 ? (
                <circle
                  cx={ring.size / 2}
                  cy={ring.size / 2}
                  r={outerRadius - index * ring.spacing}
                  strokeWidth={ring.stroke}
                  strokeLinecap="round"
                  pathLength={100}
                  strokeDasharray={`${row.remainingPercent} 100`}
                  className={cn(
                    "transition-[stroke-dasharray] duration-500 motion-reduce:transition-none",
                    tone.stroke,
                  )}
                />
              ) : null}
            </g>
          ))}
        </svg>
        <span className={cn("absolute flex", ring.iconClassName)}>
          <ProviderIcon
            provider={provider}
            className={cn("size-full", unavailable && "opacity-50")}
          />
          <ProviderAccountDot
            accentColor={instance.raw.accentColor}
            always={account.dotted}
            className="absolute -top-0.5 -right-1 size-1.5 ring-0"
          />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="right"
        align="end"
        sideOffset={8}
        className={RAIL_USAGE_POPOVER_CLASS_NAME}
      >
        <RailUsagePopoverShell
          sourceLabel={format("sidebar.railUsage.source", { source: sourceName })}
          manageLabel={t("sidebar.railUsage.manageUsage")}
          onManageUsage={() => {
            setOpen(false);
            onOpenUsageSettings();
          }}
        >
          {rings.length > 1 ? (
            <div className="flex items-center gap-3 text-muted-foreground">
              {rings.map(({ row, tone }, index) => (
                <StatusChip key={row.id} dotClassName={tone.dot}>
                  {row.label} · {index === 0 ? "outer" : "inner"}
                </StatusChip>
              ))}
            </div>
          ) : null}
          <ProviderUsagePanelContent
            provider={provider}
            rateLimits={model.rateLimits}
            usageLines={model.usageLines}
            notice={model.notice}
            emptyMessage={model.emptyMessage}
            isLoading={model.isLoading}
            resetCredits={model.resetCredits}
            resetCreditsSurface="popover"
            showTitle={false}
          />
        </RailUsagePopoverShell>
      </PopoverPopup>
    </Popover>
  );
}

/** The Moss quota, shared by every agent's Moss account: one ring with the Moss mark. */
function AppRailMossUsageRing({
  compact,
  onOpenUsageSettings,
}: {
  compact: boolean;
  onOpenUsageSettings: () => void;
}) {
  const { format, locale, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const quotaSummary = useMossQuotaSummary();
  const { accountIdentity, quota } = useMossPayQuotaQuery();
  const catalogQuery = useQuery(
    serverMossPayCatalogQueryOptions({ enabled: accountIdentity !== null }),
  );
  if (
    !quotaSummary.signedIn ||
    (quotaSummary.remainingPercent === null && !quotaSummary.unlimited)
  ) {
    return null;
  }
  const remainingPercent = quotaSummary.unlimited ? 100 : (quotaSummary.remainingPercent ?? 0);
  const tone = RING_TONE_CLASS_NAME[railUsageRingTone(remainingPercent)];
  const ring = compact ? COMPACT_SINGLE_RING : SINGLE_RING;
  const radius = (ring.size - ring.stroke) / 2;
  const label = quotaSummary.status ? `Moss, ${quotaSummary.status}` : "Moss";

  const planPresentation = resolveMossPlanPresentation({
    planCode: quota?.planCode,
    catalog: catalogQuery.data,
    unavailableLabel: "Moss",
    freePlanLabel: t("mossPay.settings.freePlan"),
  });
  const isFreePlan =
    planPresentation.isBuiltInFreePlan ||
    quota?.billingModel === "wallet_credits_v1" ||
    isBuiltInFreeMossPlanCode(quota?.planCode);
  const sourceLabel = planPresentation.name === "Moss" ? "Moss" : `Moss · ${planPresentation.name}`;
  const visibleLimits = (quota?.usageLimits ?? []).filter((limit) => limit.limit !== null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <RailUsageRingButton
            ariaLabel={`${label}. ${t("sidebar.railUsage.open")}`}
            compact={compact}
            title={label}
            data-rail-usage-moss=""
          />
        }
      >
        <svg
          viewBox={`0 0 ${ring.size} ${ring.size}`}
          className={cn("-rotate-90", ring.svgClassName)}
          fill="none"
          aria-hidden
        >
          <circle
            cx={ring.size / 2}
            cy={ring.size / 2}
            r={radius}
            strokeWidth={ring.stroke}
            className="stroke-current opacity-15"
          />
          {remainingPercent > 0 ? (
            <circle
              cx={ring.size / 2}
              cy={ring.size / 2}
              r={radius}
              strokeWidth={ring.stroke}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${remainingPercent} 100`}
              className={cn(
                "transition-[stroke-dasharray] duration-500 motion-reduce:transition-none",
                tone.stroke,
              )}
            />
          ) : null}
        </svg>
        <span className={cn("absolute flex", ring.iconClassName)}>
          <MossLogo className="size-full" />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="right"
        align="end"
        sideOffset={8}
        className={RAIL_USAGE_POPOVER_CLASS_NAME}
      >
        <RailUsagePopoverShell
          sourceLabel={format("sidebar.railUsage.source", { source: sourceLabel })}
          manageLabel={t("sidebar.railUsage.manageUsage")}
          onManageUsage={() => {
            setOpen(false);
            onOpenUsageSettings();
          }}
        >
          {quotaSummary.unlimited ? (
            <div className="flex items-center justify-between gap-4">
              <span className="truncate text-ui text-foreground">Moss</span>
              <span className="shrink-0 font-medium text-foreground">
                {t("mossPay.quota.unlimited")}
              </span>
            </div>
          ) : visibleLimits.length > 0 && quota ? (
            <div className="space-y-2">
              {visibleLimits.map((limit) => {
                const limitRemaining = mossQuotaRemainingPercent(limit.used, limit.limit);
                const countdown = formatMossResetCountdown(limit.resetsAt, locale);
                const windowLabel = usageWindowLabel(limit.key, t, quota.billingModel, isFreePlan);
                const valueLabel =
                  limitRemaining === null
                    ? t("mossPay.quota.unknown")
                    : limitRemaining === 0
                      ? t("mossPay.settings.limitReachedBadge")
                      : format("mossPay.settings.remainingPercent", {
                          value: formatMossPayCount(limitRemaining, locale),
                        });
                return (
                  <div key={limit.key} className="flex items-baseline justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-ui text-foreground">{windowLabel}</div>
                      {countdown ? (
                        <div className="text-ui-xs text-muted-foreground tabular-nums">
                          {countdown}
                        </div>
                      ) : null}
                    </div>
                    <span
                      className={cn(
                        "shrink-0 text-ui font-medium tabular-nums",
                        limitRemaining === 0 ? "text-destructive" : "text-foreground",
                      )}
                    >
                      {valueLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <span className="truncate text-ui text-foreground">Moss</span>
              {quotaSummary.status ? (
                <span className="shrink-0 font-medium text-foreground tabular-nums">
                  {quotaSummary.status}
                </span>
              ) : null}
            </div>
          )}
        </RailUsagePopoverShell>
      </PopoverPopup>
    </Popover>
  );
}

/** Sits above Help: a ring per selected account, with the windows chosen in Settings → Usage. */
export function AppRailUsage({ onOpenUsageSettings }: { onOpenUsageSettings: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const selected = settings.railUsageInstanceIds ?? settings.railUsageProviders;
  const showsMoss = selected.includes(MOSS_RAIL_USAGE_ID);
  const accounts = resolveRailUsageAccounts(
    selected,
    getRailUsageAccounts(
      deriveProviderInstances(settingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW),
      settings.disabledProviders,
      t("chat.modelPicker.source.local"),
    ),
  );
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions({ enabled: accounts.length > 0 }));

  if (accounts.length === 0 && !showsMoss) {
    return null;
  }

  // Any number of accounts can be chosen. Past two the rings shrink and the stack scrolls
  // (about four compact rings tall), so it never grows over the controls below it.
  const compact = accounts.length + (showsMoss ? 1 : 0) > RAIL_USAGE_FULL_SIZE_RINGS;
  const mossRing = showsMoss ? (
    <AppRailMossUsageRing
      key={MOSS_RAIL_USAGE_ID}
      compact={compact}
      onOpenUsageSettings={onOpenUsageSettings}
    />
  ) : null;
  const accountRings = accounts.map((account) => (
    <AppRailUsageRing
      key={account.instance.instanceId}
      account={account}
      snapshot={(usageQuery.data ?? []).find(
        (entry) =>
          entry.provider === account.instance.driver &&
          providerUsageSnapshotInstanceId(entry) === account.instance.instanceId,
      )}
      window={settings.railUsageWindow}
      compact={compact}
      onOpenUsageSettings={onOpenUsageSettings}
    />
  ));
  const rings = (
    <>
      {mossRing}
      {accountRings}
    </>
  );
  if (!compact) {
    return rings;
  }
  return (
    <div
      data-rail-usage-list
      className="flex max-h-[8rem] min-h-0 w-full shrink-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain py-0.5 [scrollbar-width:none]"
    >
      {rings}
    </div>
  );
}
