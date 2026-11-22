import type { DesktopUpdateState } from "@moss/contracts";
import { createCentralIconComponent } from "~/lib/central-icons";
import { UpdateDownloadIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadPercent,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";
import {
  RAIL_UPDATE_BUTTON_CLASS_NAME,
  RAIL_UPDATE_DISC_CLASS_NAME,
  RailProgressRing,
} from "./providerUpdates/RailUpdateVisuals";
import { SidebarIconButton } from "./SidebarIconButton";

const RestartIcon = createCentralIconComponent("arrow-rotate-clockwise");

/** Rail presentation; Sidebar retains updater subscription and action ownership. */
export function DesktopUpdateRailButton({
  state,
  installing,
  onClick,
  label: labelOverride,
}: {
  state: DesktopUpdateState;
  installing: boolean;
  onClick: () => void;
  /** Localized text for states whose copy lives in the translations (the download notice). */
  label?: string | undefined;
}) {
  const label = labelOverride ?? getDesktopUpdateButtonTooltip(state, { installing });
  const disabled = isDesktopUpdateButtonDisabled(state) || installing;
  const percent = getDesktopUpdateDownloadPercent(state);
  const readyToInstall = resolveDesktopUpdateButtonAction(state) === "install";
  const preparing =
    !installing &&
    percent === null &&
    !state.manualDownloadUrl &&
    ((state.status === "available" && state.errorContext !== "download") ||
      state.status === "downloading");
  return (
    <SidebarIconButton
      icon={UpdateDownloadIcon}
      label={label}
      tooltip={label}
      tooltipSide="right"
      size="lg"
      aria-disabled={disabled || undefined}
      disabled={disabled}
      data-rail-update-state="desktop"
      className={cn(RAIL_UPDATE_BUTTON_CLASS_NAME, disabled && "cursor-not-allowed")}
      onClick={onClick}
    >
      {installing ? (
        <RailProgressRing spinning>
          <RestartIcon className="size-3.5" />
        </RailProgressRing>
      ) : percent !== null ? (
        <RailProgressRing percent={percent}>
          <span
            data-desktop-update-percent={percent}
            style={{ fontSize: percent >= 100 ? "7.5px" : "8.5px" }}
            className="font-medium leading-none tracking-[-0.04em] text-foreground tabular-nums"
          >
            {percent}%
          </span>
        </RailProgressRing>
      ) : preparing ? (
        <RailProgressRing spinning>
          <UpdateDownloadIcon className="size-3.5" />
        </RailProgressRing>
      ) : readyToInstall ? (
        <RailProgressRing percent={100}>
          <RestartIcon className="size-3.5" />
        </RailProgressRing>
      ) : (
        <span className={RAIL_UPDATE_DISC_CLASS_NAME}>
          <UpdateDownloadIcon className="size-3.5" />
        </span>
      )}
    </SidebarIconButton>
  );
}
