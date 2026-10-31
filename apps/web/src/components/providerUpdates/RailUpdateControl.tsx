// FILE: RailUpdateControl.tsx
// Purpose: The update button above the rail avatar and its status pill, adapted from T3 Code's
//          SidebarUpdatePill and SidebarProviderUpdatePill (MIT) for a narrow rail: the pill floats
//          beside the rail, where T3 Code's sidebar footer would hold it.
// Layer: Web shell navigation.

import type { DesktopUpdateState } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type CSSProperties } from "react";

import { useAppSettings } from "~/appSettings";
import { createCentralIconComponent } from "~/lib/central-icons";
import { CircleCheckIcon, DownloadIcon, TriangleAlertIcon, XIcon } from "~/lib/icons";
import { serverConfigQueryOptions, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { getNotifiableProviderUpdateStatuses } from "~/providerUpdates";
import { SETTINGS_TARGETS } from "~/settingsNavigation";

import { resolveDesktopUpdateButtonAction } from "../desktopUpdate.logic";
import { DesktopUpdateRailButton } from "../DesktopUpdateRailButton";
import { SidebarIconButton } from "../SidebarIconButton";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderUpdateDialog } from "./ProviderUpdateDialog";
import {
  collectProviderUpdateTargets,
  resolveRailUpdatePresentation,
  type ProviderUpdatePillTone,
  type ProviderUpdatePillView,
} from "./providerUpdateRail.logic";
import { runProviderUpdates, useProviderUpdateRunStore } from "./providerUpdateRunStore";
import { RAIL_UPDATE_BUTTON_CLASS_NAME, RailProgressRing } from "./RailUpdateVisuals";
import { useProviderUpdatePill } from "./useProviderUpdatePill";

const UpdateArrowCircleIcon = createCentralIconComponent("arrow-up-circle");
const UpdateArrowIcon = createCentralIconComponent("arrow-up");

function UpdatingIcon() {
  return (
    <RailProgressRing spinning>
      <UpdateArrowIcon className="size-3.5 animate-update-rise motion-reduce:animate-none" />
    </RailProgressRing>
  );
}

const PILL_TONE_CLASSES: Record<ProviderUpdatePillTone, string> = {
  loading: "text-foreground",
  success: "text-foreground",
  warning: "bg-warning/12 text-warning",
  error: "bg-destructive/12 text-destructive",
};

const PILL_MAIN_HOVER_CLASSES: Record<ProviderUpdatePillTone, string> = {
  loading: "hover:bg-accent/60",
  success: "hover:bg-accent/60",
  warning: "hover:bg-warning/6",
  error: "hover:bg-destructive/6",
};

function RailUpdatePill({
  view,
  exiting,
  onOpenSettings,
  onDismiss,
  dismissLabel,
}: {
  readonly view: ProviderUpdatePillView;
  readonly exiting: boolean;
  readonly onOpenSettings: () => void;
  readonly onDismiss: () => void;
  readonly dismissLabel: string;
}) {
  const dismissMs = view.dismissAfterVisibleMs;
  return (
    <div
      data-provider-update-pill={view.tone}
      className={cn(
        "absolute bottom-0 left-full z-30 ml-2 w-max max-w-64 overflow-hidden rounded-lg border border-[color:var(--color-border-light)] bg-popover text-ui-sm font-medium shadow-[0_8px_24px_-8px_rgba(0,0,0,0.28)] transition-[opacity,translate] duration-180 ease-out starting:translate-y-1.5 starting:opacity-0 motion-reduce:transition-none",
        exiting ? "pointer-events-none translate-y-1.5 opacity-0" : "translate-y-0 opacity-100",
      )}
    >
      <div
        className={cn(
          "relative flex min-h-8 items-center transition-colors",
          PILL_TONE_CLASSES[view.tone],
        )}
      >
        {dismissMs !== undefined && !exiting ? (
          <div
            key={view.key}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 w-full origin-left scale-x-0 bg-foreground/6 transition-transform duration-(--provider-update-pill-dismiss-ms) ease-linear starting:scale-x-100 motion-reduce:hidden"
            style={{ "--provider-update-pill-dismiss-ms": `${dismissMs}ms` } as CSSProperties}
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={view.description}
                data-provider-update-main
                className={cn(
                  "relative z-[1] flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                  PILL_MAIN_HOVER_CLASSES[view.tone],
                )}
                onClick={onOpenSettings}
              >
                {view.tone === "loading" ? (
                  <Spinner className="size-3.5 shrink-0" />
                ) : view.tone === "success" ? (
                  <CircleCheckIcon className="size-3.5 shrink-0" />
                ) : view.tone === "error" ? (
                  <TriangleAlertIcon className="size-3.5 shrink-0" />
                ) : (
                  <DownloadIcon className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 wrap-break-word">{view.title}</span>
              </button>
            }
          />
          <TooltipPopup side="top" className="max-w-72">
            {view.description}
          </TooltipPopup>
        </Tooltip>
        {view.dismissible ? (
          <button
            type="button"
            aria-label={dismissLabel}
            className="relative z-[1] mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-70 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onClick={onDismiss}
          >
            <XIcon className="size-3.5 shrink-0" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Renders nothing unless there is an update to act on or follow. */
export function RailUpdateControl({
  desktopUpdate,
}: {
  /** Sidebar owns the updater subscription and its actions; this only presents them. */
  readonly desktopUpdate: {
    readonly state: DesktopUpdateState | null;
    readonly visible: boolean;
    readonly installing: boolean;
    readonly onClick: () => void;
  };
}) {
  const i18n = useTranslation();
  const { t, format } = i18n;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const liveVersionCheckCompleted = useProviderUpdateRunStore(
    (state) => state.liveVersionCheckCompleted,
  );
  const run = useProviderUpdateRunStore((state) => state.run);
  const [confirming, setConfirming] = useState(false);

  const providers = serverConfigQuery.data?.providers ?? [];
  const targets = collectProviderUpdateTargets(
    getNotifiableProviderUpdateStatuses({
      providers,
      hiddenProviders: settings.hiddenProviders,
      serverSettings: serverSettingsQuery.data
        ? {
            ...serverSettingsQuery.data,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }
        : null,
      liveVersionCheckCompleted,
    }),
  );
  const pill = useProviderUpdatePill({ providers, run, i18n });
  const desktopState = desktopUpdate.state;
  const presentation = resolveRailUpdatePresentation({
    pillTone: pill.liveTone,
    targetCount: targets.length,
    desktop: {
      visible: desktopUpdate.visible && desktopState !== null,
      status: desktopState?.status ?? null,
    },
  });

  if (!presentation && !pill.view) return null;

  const appUpdateVersion =
    desktopState && resolveDesktopUpdateButtonAction(desktopState) === "install"
      ? desktopState.downloadedVersion
      : null;
  const providerTooltip =
    presentation === "update"
      ? targets.length === 1
        ? t("providerUpdate.tooltip.one")
        : format("providerUpdate.tooltip.many", { count: targets.length })
      : (pill.view?.description ?? "");

  return (
    <div className="relative flex shrink-0 flex-col items-center">
      {presentation === "desktop" && desktopState ? (
        <DesktopUpdateRailButton
          state={desktopState}
          installing={desktopUpdate.installing}
          onClick={desktopUpdate.onClick}
        />
      ) : presentation ? (
        <SidebarIconButton
          icon={UpdateArrowCircleIcon}
          label={providerTooltip}
          tooltip={providerTooltip}
          tooltipSide="right"
          size="lg"
          aria-disabled={presentation === "update" ? undefined : true}
          data-rail-update-state={presentation}
          className={cn(
            RAIL_UPDATE_BUTTON_CLASS_NAME,
            presentation !== "update" && "cursor-default",
          )}
          onClick={() => {
            if (presentation === "update") setConfirming(true);
          }}
        >
          {presentation === "updating" ? (
            <UpdatingIcon />
          ) : presentation === "success" ? (
            <CircleCheckIcon className="size-4 animate-update-pop motion-reduce:animate-none" />
          ) : (
            <UpdateArrowCircleIcon className="size-4" />
          )}
        </SidebarIconButton>
      ) : null}
      {pill.view ? (
        <RailUpdatePill
          view={pill.view}
          exiting={pill.exiting}
          onOpenSettings={() => {
            void navigate({
              to: "/settings",
              search: { section: "providers", target: SETTINGS_TARGETS.providerUpdates },
            });
          }}
          onDismiss={pill.dismiss}
          dismissLabel={t("providerUpdate.pill.dismiss")}
        />
      ) : null}
      <ProviderUpdateDialog
        open={confirming}
        onOpenChange={setConfirming}
        targets={targets}
        appUpdateVersion={appUpdateVersion}
        onConfirm={() => {
          setConfirming(false);
          void runProviderUpdates(targets, queryClient, i18n);
        }}
      />
    </div>
  );
}
