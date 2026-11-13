// FILE: BackendStartupFailureView.tsx
// Purpose: Replaces the window's loading state when the desktop gives up starting
//          Moss's local service, with the actions that can still help.
// Layer: Web app shell
// Exports: BackendStartupFailureOverlay, BackendStartupFailureView,
//          useDesktopBackendStartupFailure
// Why: without it the sidebar kept saying "Loading projects…" forever and the only
//      explanation was a native dialog that could open behind the window.

import type { DesktopBackendStartupBridge, DesktopBackendStartupFailure } from "@moss/contracts";
import { useEffect, useId, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useTranslation } from "~/localization";
import { MossLogoMark } from "./MossLogoMark";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";

function readBackendStartupBridge(): DesktopBackendStartupBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.backendStartup;
}

/** The desktop's give-up state; null while the local service is starting or running. */
export function useDesktopBackendStartupFailure(
  bridge: DesktopBackendStartupBridge | undefined = readBackendStartupBridge(),
): DesktopBackendStartupFailure | null {
  const [failure, setFailure] = useState<DesktopBackendStartupFailure | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let pushed = false;
    const unsubscribe = bridge.onFailure((next) => {
      pushed = true;
      if (!disposed) setFailure(next);
    });
    // Asking also tells the desktop this window draws the failure itself.
    void bridge.getFailure().then(
      (current) => {
        if (!disposed && !pushed) setFailure(current);
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);
  return failure;
}

export function BackendStartupFailureView({
  failure,
  onRetry,
  onOpenLogFolder,
}: {
  failure: DesktopBackendStartupFailure;
  onRetry: () => Promise<void>;
  onOpenLogFolder: () => Promise<void>;
}) {
  const { t, format } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const [retrying, setRetrying] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const retry = () => {
    setRetrying(true);
    void onRetry()
      .catch(() => undefined)
      .finally(() => setRetrying(false));
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-0 z-[240] flex flex-col bg-background text-foreground"
    >
      {/* The window is frameless: keep it movable while nothing else is drawn. */}
      <div className="drag-region h-10 shrink-0" />
      <Empty>
        <EmptyHeader>
          <MossLogoMark className="mb-ui-gap-md size-8" />
          <EmptyTitle id={titleId}>{t("backendStartup.failed.title")}</EmptyTitle>
          <EmptyDescription id={descriptionId}>
            {format("backendStartup.failed.description", { count: failure.failures })}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-ui-gap-xs">
            <Button disabled={retrying} onClick={retry}>
              {retrying ? t("backendStartup.failed.retrying") : t("backendStartup.failed.retry")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void onOpenLogFolder().catch(() => undefined)}
            >
              {t("backendStartup.failed.openLogs")}
            </Button>
            <Button variant="secondary" onClick={() => copyToClipboard(failure.details, undefined)}>
              {isCopied
                ? t("backendStartup.failed.copied")
                : t("backendStartup.failed.copyDetails")}
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    </div>
  );
}

/** Mounted once in the app shell; draws nothing unless the desktop gave up. */
export function BackendStartupFailureOverlay() {
  const [bridge] = useState(readBackendStartupBridge);
  const failure = useDesktopBackendStartupFailure(bridge);
  if (!bridge || !failure) return null;
  return (
    <BackendStartupFailureView
      failure={failure}
      onRetry={() => bridge.retry()}
      onOpenLogFolder={() => bridge.openLogFolder()}
    />
  );
}
