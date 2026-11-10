// FILE: SettingsDialog.tsx
// Purpose: Settings as a floating dialog over the app (the Claude desktop form): a title
//          strip with a close button, the page list on the left and the page on the right.
//          Closed with ×, Esc or a click outside; deep links open it at a page or row.
// Layer: Settings UI shell
// Exports: SettingsDialog, SettingsDialogHost

import { useLocation } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import { useTranslation } from "~/localization";
import { rememberSettingsBackground } from "~/settingsBackground";
import {
  closeSettings,
  navigateSettings,
  settingsDialogStore,
  type SettingsOpenRequest,
} from "~/settingsDialogStore";
import { resolveSettingsLocation } from "~/settingsLocation";
import { SettingsSidebarNav } from "../SettingsSidebarNav";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { XIcon } from "~/lib/icons";

// The pages pull in most of the settings code; load them the first time Settings opens.
const SettingsContent = lazy(() =>
  import("./SettingsContent").then((module) => ({ default: module.SettingsContent })),
);

/**
 * Geometry measured from Claude desktop 4.23118 (`[data-settings-dialog]`): centred,
 * 2rem short of the window on each axis, capped at 1024 × 800, 12px radius, a fade with a
 * 0.98 scale-in. Like Claude, the vertical inset is never less than the desktop title
 * bar, so the window's own buttons stay uncovered. The page list is a fixed column; the
 * page scrolls on its own.
 */
export const SETTINGS_DIALOG_POPUP_CLASS_NAME =
  "max-h-[50rem] w-[calc(100vw-2rem)] max-w-[1024px] overflow-hidden p-0";
/** The desktop title bar is 44px (`CHAT_SURFACE_HEADER_HEIGHT_PX`); the web keeps 1rem. */
export const SETTINGS_DIALOG_TITLE_BAR_INSET_PX = 44;
const SETTINGS_DIALOG_INSET = isElectron
  ? { viewport: "py-11", popup: "h-[calc(100dvh-5.5rem)]" }
  : { viewport: "py-4", popup: "h-[calc(100dvh-2rem)]" };

export function SettingsDialog() {
  const { t } = useTranslation();
  const isOpen = useStore(settingsDialogStore, (state) => state.isOpen);
  const request = useStore(settingsDialogStore, (state) => state.request);
  const openEpoch = useStore(settingsDialogStore, (state) => state.openEpoch);
  const location = useMemo(() => resolveSettingsLocation(request), [request]);
  const close = closeSettings;
  // Focus lands on the page, not on the close button, so nothing shows a ring on open.
  const pageRef = useRef<HTMLElement>(null);

  const onNavigate: (next: SettingsOpenRequest) => void = navigateSettings;

  // The screen behind can focus itself while Settings is open (the composer does after a
  // deep link brings its chat back). Anything inside the app root is behind the dialog,
  // so focus goes back to the page; menus and nested dialogs portal outside the root.
  useEffect(() => {
    if (!isOpen) return;
    const appRoot = document.getElementById("root");
    if (!appRoot) return;
    const keepFocusInDialog = (event: FocusEvent) => {
      if (event.target instanceof Node && appRoot.contains(event.target)) {
        pageRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", keepFocusInDialog);
    return () => document.removeEventListener("focusin", keepFocusInDialog);
  }, [isOpen]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup
        data-settings-dialog=""
        data-testid="settings-dialog"
        showCloseButton={false}
        bottomStickOnMobile={false}
        backdropClassName="bg-black/25"
        viewportClassName={SETTINGS_DIALOG_INSET.viewport}
        className={cn(SETTINGS_DIALOG_POPUP_CLASS_NAME, SETTINGS_DIALOG_INSET.popup)}
        initialFocus={pageRef}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--color-border)] ps-5 pe-2.5">
          <DialogTitle className="font-sans text-ui-lg font-medium">
            {t("settings.dialog.title")}
          </DialogTitle>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("settings.dialog.close")}
            onClick={close}
          >
            <XIcon />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1">
          <aside
            className="flex w-56 shrink-0 flex-col overflow-y-auto border-e border-[color:var(--color-border)] px-1.5 pt-2 pb-3"
            data-testid="settings-dialog-nav"
          >
            <SettingsSidebarNav
              activeSection={location.section}
              onSelectSection={(section, options) =>
                onNavigate({ section, ...(options?.target ? { target: options.target } : {}) })
              }
            />
          </aside>
          <main
            ref={pageRef}
            tabIndex={-1}
            className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
            data-testid="settings-dialog-page"
          >
            <Suspense
              fallback={
                <p className="px-8 pt-8 text-ui text-muted-foreground">
                  {t("settings.dialog.loading")}
                </p>
              }
            >
              {isOpen ? (
                <SettingsContent key={openEpoch} location={location} onNavigate={onNavigate} />
              ) : null}
            </Suspense>
          </main>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Mounted once in the chat shell: draws the dialog and remembers the screen behind it,
 * so a `/settings` deep link returns there after opening Settings.
 */
export function SettingsDialogHost() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const href = useLocation({ select: (location) => location.href });
  useEffect(() => {
    rememberSettingsBackground(pathname, href);
  }, [href, pathname]);
  return <SettingsDialog />;
}
