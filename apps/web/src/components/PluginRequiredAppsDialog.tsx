// FILE: PluginRequiredAppsDialog.tsx
// Purpose: Frozen Codex 6234 multi-app post-install connector onboarding.

import { useEffect, useRef } from "react";

import { useTranslation } from "~/localization";
import { AppsIcon, CheckIcon, MessageCircleIcon, PluginIcon, RefreshCwIcon } from "~/lib/icons";
import { OpenAI } from "./Icons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import type { PluginRequiredApp } from "./pluginAuthOnboarding";

export type { PluginRequiredApp } from "./pluginAuthOnboarding";

export interface PluginRequiredAppsDialogProps {
  readonly open: boolean;
  readonly pluginName: string;
  readonly pluginLogoUrl: string | null;
  readonly apps: readonly PluginRequiredApp[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onConnect: (app: PluginRequiredApp) => void | Promise<void>;
  readonly onViewDetails: () => void;
  readonly onTryNow: () => void;
}

export function PluginRequiredAppsDialog({
  open,
  pluginName,
  pluginLogoUrl,
  apps,
  onOpenChange,
  onConnect,
  onViewDetails,
  onTryNow,
}: PluginRequiredAppsDialogProps) {
  const { format, t } = useTranslation();
  const activeAppIdsRef = useRef(new Set<string>());
  const activeFooterActionsRef = useRef(new Set<"details" | "try">());

  useEffect(() => {
    if (!open) {
      activeAppIdsRef.current.clear();
      activeFooterActionsRef.current.clear();
    }
  }, [open]);

  useEffect(() => {
    for (const app of apps) {
      if (app.status !== "pending") activeAppIdsRef.current.delete(app.id);
    }
  }, [apps]);

  const connect = (app: PluginRequiredApp) => {
    if (app.status !== "pending" || activeAppIdsRef.current.has(app.id)) return;
    activeAppIdsRef.current.add(app.id);
    void Promise.resolve(onConnect(app)).finally(() => {
      activeAppIdsRef.current.delete(app.id);
    });
  };

  const runFooterAction = (action: "details" | "try", callback: () => void) => {
    if (activeFooterActionsRef.current.has(action)) return;
    activeFooterActionsRef.current.add(action);
    try {
      callback();
    } finally {
      queueMicrotask(() => activeFooterActionsRef.current.delete(action));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-modal="true"
        className="max-h-[min(720px,calc(100vh-2rem))] max-w-[480px] overflow-hidden"
      >
        <span role="status" aria-live="polite" className="sr-only">
          {apps
            .map((app) =>
              app.status === "connected"
                ? `${app.name} ${t("plugins.installModal.requiredApps.connected")}`
                : app.status === "opened"
                  ? `${app.name} ${t("plugins.installModal.requiredApps.openedLink")}`
                  : `${app.name} ${t("plugins.installModal.requiredApps.connect")}`,
            )
            .join(". ")}
        </span>
        <DialogHeader className="flex shrink-0 flex-col items-center gap-4 px-6 pt-9 pb-4 text-center">
          <div className="flex items-center gap-4" aria-hidden="true">
            <span className="flex size-[60px] items-center justify-center rounded-2xl bg-black text-white shadow-sm">
              <OpenAI className="size-12" />
            </span>
            <span className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-border" />
              <span className="size-1.5 rounded-full bg-border" />
              <span className="size-1.5 rounded-full bg-border" />
            </span>
            <span className="flex size-[60px] items-center justify-center overflow-hidden rounded-2xl border border-border bg-muted shadow-sm">
              {pluginLogoUrl ? (
                <img src={pluginLogoUrl} alt="" className="size-full object-contain" />
              ) : (
                <PluginIcon className="size-7 text-muted-foreground" />
              )}
            </span>
          </div>
          <div className="flex flex-col items-center gap-2 text-center">
            <DialogTitle>
              {format("plugins.installModal.needsApps.title", { pluginName })}
            </DialogTitle>
            <DialogDescription className="max-w-[390px] leading-5">
              {t("plugins.installModal.needsApps.subtitle")}
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogPanel className="relative grid min-h-0 flex-1 px-6 pb-0">
          <div className="divide-y divide-border/60">
            {apps.map((app) => {
              const appLogo = app.logoUrl ?? app.logoUrlDark;
              const connected = app.status === "connected";
              const opened = app.status === "opened";
              const launching = app.status === "launching";
              return (
                <div key={app.id} className="flex min-h-[72px] items-center gap-3 py-3">
                  <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
                    {appLogo ? (
                      <img
                        src={appLogo}
                        alt={format("settings.mcp.appConnectModal.logoAlt", {
                          appName: app.name,
                        })}
                        className="size-full object-contain"
                      />
                    ) : (
                      <AppsIcon className="size-5 text-muted-foreground" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ui-lg font-medium text-foreground">
                      {app.name}
                    </div>
                    {app.description ? (
                      <div className="line-clamp-2 text-ui-sm leading-4 text-muted-foreground">
                        {app.description}
                      </div>
                    ) : null}
                  </div>
                  <Button
                    data-plugin-required-app-id={app.id}
                    variant={connected || opened ? "ghost" : "outline"}
                    size="sm"
                    disabled={connected || opened || launching}
                    onClick={() => connect(app)}
                  >
                    {connected ? (
                      <>
                        <CheckIcon className="size-3.5" />
                        {t("plugins.installModal.requiredApps.connected")}
                      </>
                    ) : opened ? (
                      t("plugins.installModal.requiredApps.openedLink")
                    ) : (
                      <>
                        {launching ? <RefreshCwIcon className="size-3.5 animate-spin" /> : null}
                        {t("plugins.installModal.requiredApps.connect")}
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        </DialogPanel>

        <DialogFooter className="h-[84px] shrink-0 !flex-row items-center justify-end gap-2 px-6 py-0">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => runFooterAction("details", onViewDetails)}
          >
            {t("plugins.installModal.viewDetails")}
          </Button>
          <Button size="sm" onClick={() => runFooterAction("try", onTryNow)}>
            <MessageCircleIcon className="size-4" />
            {format("plugins.installModal.tryNow", { pluginName })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
