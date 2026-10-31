import type { DesktopUpdateState } from "@synara/contracts";
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
  RailProgressRing,
} from "./providerUpdates/RailUpdateVisuals";
import { SidebarIconButton } from "./SidebarIconButton";

const RestartIcon = createCentralIconComponent("arrow-rotate-clockwise");

/** Rail presentation; Sidebar retains updater subscription and action ownership. */
export function DesktopUpdateRailButton({
  state,
  installing,
  onClick,
}: {
  state: DesktopUpdateState;
  installing: boolean;
  onClick: () => void;
}) {
  const label = getDesktopUpdateButtonTooltip(state, { installing });
  const disabled = isDesktopUpdateButtonDisabled(state) || installing;
  const percent = getDesktopUpdateDownloadPercent(state);
  const readyToInstall = resolveDesktopUpdateButtonAction(state) === "install";
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
      {percent !== null ? (
        <RailProgressRing percent={percent}>
          <UpdateDownloadIcon className="size-3.5" />
        </RailProgressRing>
      ) : readyToInstall ? (
        <RestartIcon className="size-4" />
      ) : (
        <UpdateDownloadIcon className="size-4" />
      )}
    </SidebarIconButton>
  );
}
