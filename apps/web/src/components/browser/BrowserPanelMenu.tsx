// FILE: BrowserPanelMenu.tsx
// Purpose: The browser panel's "…" menu: open the page in the system browser, copy its
//   URL, save a screenshot, open an HTML file, view a local page's source, viewport
//   presets, the three panel toggles, the sites local pages may reach, how long cookies
//   are kept, and clearing browsing data. Items that need a page are greyed on a new tab.
// Layer: BrowserPanel UI (in the panel's own header row)

import type { ThreadId } from "@moss/contracts";
import {
  isBlankBrowserTabUrl,
  localFilePathFromUrl,
  localFileUrlFromPath,
} from "@moss/shared/browserSession";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useAppSettings } from "~/appSettings";
import { EllipsisIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { readNativeApi } from "~/nativeApi";

import { selectThreadBrowserState, useBrowserStateStore } from "../../browserStateStore";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../chat/chatHeaderControls";
import { IconButton } from "../ui/icon-button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { openBrowserVault } from "../BrowserVault";
import { BrowserAllowedSitesDialog } from "./BrowserAllowedSitesDialog";
import { BrowserClearDataDialog } from "./BrowserClearDataDialog";
import { BROWSER_VIEWPORT_PRESETS, findBrowserViewportPreset } from "./browserPanelChrome.logic";
import {
  browserViewportTabKey,
  openUrlInThreadBrowser,
  useBrowserViewportStore,
} from "./browserPanelNavigation";

const MENU_ROW_CLASS_NAME = "min-h-7";
const MENU_HINT_CLASS_NAME = "ms-auto ps-4 text-ui-sm text-muted-foreground";
// Checks in this menu take the accent, as in the desktop panel.
const ACCENT_CHECK_CLASS_NAME = "[&_svg]:size-4 [&_svg]:text-[var(--color-text-accent)]";

type BrowserPanelDialog = "allowedSites" | "clearData" | null;

export function BrowserPanelMenu(props: {
  readonly threadId: ThreadId;
  /** Opens a local page's file as source in the file panel. */
  readonly onViewSource?: ((absolutePath: string) => void) | undefined;
  readonly triggerClassName?: string | undefined;
}) {
  const { t, format } = useTranslation();
  const api = readNativeApi();
  const panelApi = api?.browser.panel;
  const { settings, updateSettings } = useAppSettings();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<BrowserPanelDialog>(null);
  const browserState = useBrowserStateStore(selectThreadBrowserState(props.threadId));
  const activeTab =
    browserState?.tabs.find((tab) => tab.id === browserState.activeTabId) ??
    browserState?.tabs[0] ??
    null;
  const pageUrl = activeTab ? (activeTab.lastCommittedUrl ?? activeTab.url) : "";
  const hasPage = activeTab !== null && !isBlankBrowserTabUrl(activeTab);
  const localFilePath = localFilePathFromUrl(pageUrl);
  const isWebPage = hasPage && /^https?:\/\//i.test(pageUrl);
  const canOpenInBrowser =
    isWebPage || (hasPage && localFilePath !== null && panelApi?.openInBrowser !== undefined);
  const viewportKey = activeTab ? browserViewportTabKey(props.threadId, activeTab.id) : null;
  const viewportPresetId = useBrowserViewportStore((store) =>
    viewportKey ? (store.presetByTabKey[viewportKey] ?? null) : null,
  );
  const setViewportPreset = useBrowserViewportStore((store) => store.setPreset);
  const viewportPreset = findBrowserViewportPreset(viewportPresetId);
  const preferencesQuery = useQuery({
    queryKey: ["browser-panel", "preferences"],
    queryFn: () => panelApi!.getPreferences(),
    enabled: open && panelApi !== undefined,
    staleTime: 0,
  });
  const defaultBrowserQuery = useQuery({
    queryKey: ["browser-panel", "default-browser-name"],
    queryFn: () => panelApi!.getDefaultBrowserName(),
    enabled: open && panelApi !== undefined,
    staleTime: 5 * 60_000,
  });
  const cookieRetention = preferencesQuery.data?.cookieRetention ?? "keep";
  const defaultBrowserName = defaultBrowserQuery.data ?? null;

  const viewportLabel = (presetId: string | null): string => {
    const preset = findBrowserViewportPreset(presetId);
    if (!preset) return t("browser.menu.viewport.responsive");
    if (preset.id === "mobile") return t("browser.menu.viewport.mobile");
    if (preset.id === "tablet") return t("browser.menu.viewport.tablet");
    return `${preset.width} × ${preset.height}`;
  };
  const reportError = (cause: unknown) => {
    toastManager.add({
      type: "error",
      title: t("browser.menu.actionFailed"),
      description: cause instanceof Error ? cause.message : undefined,
    });
  };

  if (!api) return null;

  return (
    <>
      <Menu modal={false} open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <IconButton
              variant="chrome"
              size="icon-xs"
              label={t("browser.menu.trigger")}
              tooltip={t("browser.menu.trigger")}
              tooltipSide="bottom"
              data-browser-panel-menu=""
              className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, props.triggerClassName)}
            >
              <EllipsisIcon className="size-4" />
            </IconButton>
          }
        />
        <ComposerPickerMenuPopup align="end" side="bottom" className="w-72 min-w-72">
          <MenuItem
            className={MENU_ROW_CLASS_NAME}
            disabled={!canOpenInBrowser}
            title={hasPage && !canOpenInBrowser ? t("browser.menu.websitesOnly") : undefined}
            onClick={() => {
              if (!canOpenInBrowser) return;
              // A local page's file opens in the browser too, as Claude's "Open in browser".
              if (localFilePath && panelApi?.openInBrowser) {
                void panelApi.openInBrowser(pageUrl).catch(reportError);
                return;
              }
              void api.shell.openExternal(pageUrl);
            }}
          >
            {defaultBrowserName
              ? format("browser.menu.openIn", { browser: defaultBrowserName })
              : t("browser.menu.openInDefault")}
          </MenuItem>
          <MenuItem
            className={MENU_ROW_CLASS_NAME}
            disabled={!hasPage}
            onClick={() => {
              if (activeTab)
                void api.browser.copyLink({ threadId: props.threadId, tabId: activeTab.id });
            }}
          >
            {t("browser.menu.copyUrl")}
          </MenuItem>
          <MenuItem
            className={MENU_ROW_CLASS_NAME}
            disabled={!hasPage || !panelApi}
            onClick={() => {
              if (!activeTab || !panelApi) return;
              void panelApi
                .saveScreenshot({ threadId: props.threadId, tabId: activeTab.id })
                .then((savedPath) => {
                  if (savedPath) {
                    toastManager.add({
                      type: "success",
                      title: t("browser.menu.screenshotSaved"),
                      description: savedPath.split(/[\\/]/).at(-1),
                    });
                  }
                }, reportError);
            }}
          >
            {t("browser.menu.saveScreenshot")}
          </MenuItem>
          <MenuItem
            className={MENU_ROW_CLASS_NAME}
            disabled={!panelApi}
            onClick={() => {
              if (!panelApi) return;
              void panelApi.pickHtmlFile().then((filePath) => {
                const url = filePath ? localFileUrlFromPath(filePath) : null;
                if (url) {
                  return openUrlInThreadBrowser({ api, threadId: props.threadId, url }).then(
                    () => undefined,
                  );
                }
                return undefined;
              }, reportError);
            }}
          >
            {t("browser.menu.openHtmlFile")}
          </MenuItem>
          {localFilePath && props.onViewSource ? (
            <MenuItem
              className={MENU_ROW_CLASS_NAME}
              data-browser-view-source=""
              onClick={() => props.onViewSource?.(localFilePath)}
            >
              {t("browser.menu.viewSource")}
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuSub>
            <MenuSubTrigger className={MENU_ROW_CLASS_NAME} disabled={!hasPage}>
              <span className="flex-1">{t("browser.menu.viewport")}</span>
              <span className={MENU_HINT_CLASS_NAME}>{viewportLabel(viewportPresetId)}</span>
            </MenuSubTrigger>
            <MenuSubPopup surface="composer" className="w-60">
              <MenuRadioGroup
                value={viewportPreset?.id ?? "responsive"}
                onValueChange={(value) => {
                  if (!activeTab) return;
                  setViewportPreset(
                    props.threadId,
                    activeTab.id,
                    value === "responsive" ? null : String(value),
                  );
                }}
              >
                <MenuRadioItem
                  value="responsive"
                  className={cn(MENU_ROW_CLASS_NAME, ACCENT_CHECK_CLASS_NAME)}
                >
                  {t("browser.menu.viewport.responsive")}
                </MenuRadioItem>
                {BROWSER_VIEWPORT_PRESETS.map((preset) => (
                  <MenuRadioItem
                    key={preset.id}
                    value={preset.id}
                    data-viewport-preset={preset.id}
                    className={cn(MENU_ROW_CLASS_NAME, ACCENT_CHECK_CLASS_NAME)}
                  >
                    <span className="flex-1">{viewportLabel(preset.id)}</span>
                    <span className="text-ui-sm text-muted-foreground">{preset.hint}</span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          <MenuSeparator />
          <MenuCheckboxItem
            className={cn(MENU_ROW_CLASS_NAME, ACCENT_CHECK_CLASS_NAME)}
            checked={settings.browserOpenLinksInPanel}
            onCheckedChange={(checked) => updateSettings({ browserOpenLinksInPanel: checked })}
          >
            {t("browser.menu.openLinks")}
          </MenuCheckboxItem>
          <MenuCheckboxItem
            className={cn(MENU_ROW_CLASS_NAME, ACCENT_CHECK_CLASS_NAME)}
            checked={settings.browserAutoOpenWrittenPages}
            onCheckedChange={(checked) => updateSettings({ browserAutoOpenWrittenPages: checked })}
          >
            {t("browser.menu.autoOpenFiles")}
          </MenuCheckboxItem>
          <MenuCheckboxItem
            className={cn(MENU_ROW_CLASS_NAME, ACCENT_CHECK_CLASS_NAME)}
            checked={settings.browserAutoVerifyChanges}
            title={t("browser.menu.autoVerifyHint")}
            onCheckedChange={(checked) => updateSettings({ browserAutoVerifyChanges: checked })}
          >
            {t("browser.menu.autoVerify")}
          </MenuCheckboxItem>
          <MenuItem
            className={MENU_ROW_CLASS_NAME}
            disabled={!panelApi}
            onClick={() => setDialog("allowedSites")}
          >
            {t("browser.menu.allowedSites")}
          </MenuItem>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel className="py-1 text-ui-sm text-muted-foreground">
              {t("browser.menu.cookies")}
            </MenuGroupLabel>
            <MenuSub>
              <MenuSubTrigger className={MENU_ROW_CLASS_NAME} disabled={!panelApi}>
                <span className="flex-1">{t("browser.menu.keepCookies")}</span>
                <span className={MENU_HINT_CLASS_NAME}>
                  {cookieRetention === "untilQuit"
                    ? t("browser.menu.cookies.untilQuit")
                    : t("browser.menu.cookies.keep")}
                </span>
              </MenuSubTrigger>
              <MenuSubPopup surface="composer" className="w-72">
                <MenuRadioGroup
                  value={cookieRetention}
                  onValueChange={(value) => {
                    if (!panelApi) return;
                    void panelApi
                      .setCookieRetention(value === "untilQuit" ? "untilQuit" : "keep")
                      .then(() => preferencesQuery.refetch(), reportError);
                  }}
                >
                  <MenuRadioItem
                    value="untilQuit"
                    className={cn("h-auto py-1", ACCENT_CHECK_CLASS_NAME)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{t("browser.menu.cookies.untilQuit")}</span>
                      <span className="text-ui-sm text-muted-foreground">
                        {t("browser.menu.cookies.untilQuitHint")}
                      </span>
                    </span>
                  </MenuRadioItem>
                  <MenuRadioItem
                    value="keep"
                    className={cn("h-auto py-1", ACCENT_CHECK_CLASS_NAME)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{t("browser.menu.cookies.keep")}</span>
                      <span className="text-ui-sm text-muted-foreground">
                        {t("browser.menu.cookies.keepHint")}
                      </span>
                    </span>
                  </MenuRadioItem>
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
            {api.browser.vault ? (
              <MenuItem
                className={MENU_ROW_CLASS_NAME}
                onClick={() =>
                  openBrowserVault(
                    activeTab && isWebPage
                      ? {
                          threadId: props.threadId,
                          tabId: activeTab.id,
                          origin: new URL(pageUrl).origin,
                        }
                      : undefined,
                  )
                }
              >
                {t("browser.menu.savedLogins")}
              </MenuItem>
            ) : null}
            <MenuItem
              className={MENU_ROW_CLASS_NAME}
              variant="destructive"
              disabled={!panelApi}
              onClick={() => setDialog("clearData")}
            >
              {t("browser.menu.clearData")}
            </MenuItem>
          </MenuGroup>
        </ComposerPickerMenuPopup>
      </Menu>
      {panelApi ? (
        <BrowserAllowedSitesDialog
          open={dialog === "allowedSites"}
          onOpenChange={(next) => setDialog(next ? "allowedSites" : null)}
          panelApi={panelApi}
        />
      ) : null}
      {panelApi ? (
        <BrowserClearDataDialog
          open={dialog === "clearData"}
          onOpenChange={(next) => setDialog(next ? "clearData" : null)}
          panelApi={panelApi}
        />
      ) : null}
    </>
  );
}
