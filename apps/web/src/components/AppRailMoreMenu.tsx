// FILE: AppRailMoreMenu.tsx
// Purpose: Codex-shaped feature and common-plugin menu with persistent sidebar pins, plus
//          the Spaces and projects the user keeps in the rail as their own shortcuts.
// Layer: App shell component
import type { ComponentType, ReactNode } from "react";
import { useTranslation } from "~/localization";
import { PinStatusIcon } from "~/lib/pin";
import { CustomizeIcon, FolderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SIDEBAR_ROW_FOCUS_CLASS_NAME } from "~/sidebarRowStyles";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "./chat/ComposerPickerMenuPopup";
import { APP_RAIL_GLYPH_CLASS_NAME, appRailButtonClassName, RAIL_MORE_GLYPHS } from "./AppRail";
import { SidebarIconButton } from "./SidebarIconButton";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export type AppRailMoreMenuEntry = {
  readonly key: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly onSelect: () => void;
  readonly pinned?: boolean;
  readonly onTogglePin?: (() => void) | undefined;
};

/** A Space or project the user can add to the rail as its own shortcut. */
export type AppRailMoreMenuShortcut = {
  /** Shortcut key ("space:…" / "project:…"). */
  readonly key: string;
  readonly label: string;
};

export type AppRailMoreMenuShortcuts = {
  readonly spaces: readonly AppRailMoreMenuShortcut[];
  readonly projects: readonly AppRailMoreMenuShortcut[];
  readonly pinnedKeys: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
};

function ShortcutsSubmenu({ shortcuts }: { readonly shortcuts: AppRailMoreMenuShortcuts }) {
  const { t } = useTranslation();
  const row = (entry: AppRailMoreMenuShortcut) => (
    <MenuCheckboxItem
      key={entry.key}
      className="font-normal"
      checked={shortcuts.pinnedKeys.has(entry.key)}
      onCheckedChange={() => shortcuts.onToggle(entry.key)}
    >
      <span className="min-w-0 truncate">{entry.label}</span>
    </MenuCheckboxItem>
  );
  return (
    <MenuSub>
      <MenuSubTrigger className="font-normal">
        <FolderIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("sidebar.more.railShortcuts")}</span>
      </MenuSubTrigger>
      <ComposerPickerMenuSubPopup className="max-h-[min(28rem,calc(100dvh-5rem))] w-56 overflow-y-auto font-normal">
        {shortcuts.spaces.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel className="font-normal">{t("sidebar.more.railSpaces")}</MenuGroupLabel>
            {shortcuts.spaces.map(row)}
          </MenuGroup>
        ) : null}
        {shortcuts.spaces.length > 0 ? <MenuSeparator /> : null}
        <MenuGroup>
          <MenuGroupLabel className="font-normal">{t("sidebar.more.railProjects")}</MenuGroupLabel>
          {shortcuts.projects.length === 0 ? (
            <div className="px-2 py-1.5 text-ui-sm text-muted-foreground">
              {t("sidebar.more.noProjects")}
            </div>
          ) : (
            shortcuts.projects.map(row)
          )}
        </MenuGroup>
      </ComposerPickerMenuSubPopup>
    </MenuSub>
  );
}

function FeatureRow({ entry }: { readonly entry: AppRailMoreMenuEntry }) {
  const { t } = useTranslation();
  const Icon = entry.icon;
  const pinLabel = t(entry.pinned ? "sidebar.more.unpin" : "sidebar.more.pin");
  return (
    <div
      className="group/feature flex items-center rounded-control hover:bg-[var(--sidebar-accent)] focus-within:bg-[var(--sidebar-accent)]"
      data-rail-feature={entry.key}
    >
      <MenuItem
        className={cn("min-w-0 flex-1 bg-transparent! font-normal", SIDEBAR_ROW_FOCUS_CLASS_NAME)}
        onClick={entry.onSelect}
      >
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{entry.label}</span>
      </MenuItem>
      {entry.onTogglePin ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuItem
                closeOnClick={false}
                aria-label={`${pinLabel}: ${entry.label}`}
                data-rail-pin-action
                data-pinned={entry.pinned === true}
                className={cn(
                  // A pin is a secondary control: 12px glyph in a 24px square. The row's
                  // comfortable 32px option height must not stretch it into a 24x32 bar.
                  "size-6 min-h-0! shrink-0 justify-center p-0! text-muted-foreground! transition-colors hover:text-foreground! data-highlighted:text-foreground! focus:opacity-100 data-highlighted:opacity-100",
                  SIDEBAR_ROW_FOCUS_CLASS_NAME,
                  !entry.pinned &&
                    "sm:opacity-0 sm:group-hover/feature:opacity-100 sm:group-focus-within/feature:opacity-100",
                )}
                onClick={entry.onTogglePin}
              />
            }
          >
            <PinStatusIcon pinned={entry.pinned === true} className="size-3 opacity-100" />
          </TooltipTrigger>
          <TooltipPopup side="right">{pinLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function AppRailMoreMenu({
  destinations,
  plugins,
  utilities,
  shortcuts,
  helpMenu,
  onCustomize,
  open,
  onOpenChange,
}: {
  readonly destinations: readonly AppRailMoreMenuEntry[];
  readonly plugins: readonly AppRailMoreMenuEntry[];
  readonly utilities: readonly AppRailMoreMenuEntry[];
  /** Spaces/projects as rail shortcuts; omitted where the rail has none to offer. */
  readonly shortcuts?: AppRailMoreMenuShortcuts | undefined;
  /** The Help submenu (what's new, keybindings, feedback, docs); the rail has no other entry. */
  readonly helpMenu?: ReactNode;
  readonly onCustomize: () => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={RAIL_MORE_GLYPHS.idle}
        iconClassName={APP_RAIL_GLYPH_CLASS_NAME}
        label={t("sidebar.more.features")}
        tooltip={t("sidebar.more.features")}
        tooltipSide="right"
        className={appRailButtonClassName(open)}
      />
      <ComposerPickerMenuPopup
        align="start"
        side="right"
        sideOffset={8}
        className="w-64 min-w-56 max-w-[calc(100vw-4rem)] font-normal"
        aria-label={t("sidebar.more.features")}
      >
        <div
          className="max-h-[min(36rem,calc(100dvh-5rem))] overflow-y-auto"
          data-rail-feature-list
        >
          <MenuGroup>
            {destinations.map((entry) => (
              <FeatureRow key={entry.key} entry={entry} />
            ))}
            {shortcuts ? <ShortcutsSubmenu shortcuts={shortcuts} /> : null}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel className="font-normal">
              {t("sidebar.more.commonPlugins")}
            </MenuGroupLabel>
            {plugins.length === 0 ? (
              <div className="px-2 py-1.5 text-ui-sm text-muted-foreground">
                {t("sidebar.more.noPlugins")}
              </div>
            ) : null}
            {plugins.map((entry) => (
              <FeatureRow key={entry.key} entry={entry} />
            ))}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            {utilities.map((entry) => (
              <FeatureRow key={entry.key} entry={entry} />
            ))}
            {helpMenu}
            <MenuItem onClick={onCustomize}>
              <CustomizeIcon className="size-4" />
              {t("sidebar.more.customize")}
            </MenuItem>
          </MenuGroup>
        </div>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
