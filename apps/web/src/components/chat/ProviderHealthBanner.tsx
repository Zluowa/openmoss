// FILE: ProviderHealthBanner.tsx
// Purpose: Surfaces provider availability warnings above the active chat.
// Layer: Chat status presentation
// Exports: ProviderHealthBanner

import type { ServerProviderStatus } from "@synara/contracts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import {
  EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
  NOTIFICATION_ICON_CLASS_NAME,
} from "../ui/notificationSurface";
import { CircleAlertIcon, TriangleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";
import { useTranslation } from "~/localization";
import {
  isMossDefaultManagedProviderInstanceId,
  isMossManagedProviderStatus,
  isFreshMossManagedStartupStatus,
  isProviderDurablyUnavailable,
  isProviderUsable,
  providerStatusDisplayLabel,
  resolveProviderAvailabilityPresentationKind,
} from "../../lib/providerAvailability";

export function runProviderHealthRecoveryAction(onManageProviders: () => void): void {
  onManageProviders();
}

export const ProviderHealthBanner = function ProviderHealthBanner({
  onDismiss,
  onManageProviders,
  status,
  managedInstanceConfigured = false,
}: {
  onDismiss?: () => void;
  onManageProviders?: () => void;
  status: ServerProviderStatus | null;
  managedInstanceConfigured?: boolean;
}) {
  const { format, t } = useTranslation();
  if (!status || (status.status === "ready" && isProviderUsable(status))) {
    return null;
  }

  const providerLabel = providerStatusDisplayLabel(status);
  const isMossManaged = isMossManagedProviderStatus(status);
  const presentationKind = resolveProviderAvailabilityPresentationKind({ status });
  const isDefaultManagedTransient =
    isMossDefaultManagedProviderInstanceId(status.instanceId) && presentationKind === "transient";
  // Managed runtimes are started by the first real turn. Background inventory
  // hydration is implementation detail, not a chat-level warning or recovery task.
  if (
    isDefaultManagedTransient &&
    (managedInstanceConfigured || isFreshMossManagedStartupStatus(status))
  ) {
    return null;
  }
  // An expired/unproven managed snapshot is not a startup progress state. Keep
  // it fail-closed and actionable without resurrecting the removed preparation UI.
  const effectivePresentationKind = isDefaultManagedTransient ? "unavailable" : presentationKind;
  const isDurablyUnavailable =
    isProviderDurablyUnavailable(status) || effectivePresentationKind === "unavailable";
  const isError = effectivePresentationKind !== "transient";
  const message = (() => {
    switch (effectivePresentationKind) {
      case "disabled":
        return t("provider.health.disabled");
      case "unauthenticated":
        return format("provider.send.blocked.unauthenticated", { provider: providerLabel });
      case "unavailable":
      case "status-timeout":
        return isMossManaged
          ? t("provider.health.moss.errorDescription")
          : format("provider.health.unavailable", { provider: providerLabel });
      case "transient":
      case "status-loading":
        return isMossManaged
          ? t("provider.health.moss.warningDescription")
          : format("provider.health.limited", { provider: providerLabel });
    }
  })();
  const title = isMossManaged
    ? effectivePresentationKind === "unavailable" || effectivePresentationKind === "status-timeout"
      ? t("provider.health.moss.errorTitle")
      : effectivePresentationKind === "transient" || effectivePresentationKind === "status-loading"
        ? t("provider.health.moss.warningTitle")
        : format("provider.health.title", { provider: providerLabel })
    : format("provider.health.title", { provider: providerLabel });
  const Icon = isError ? CircleAlertIcon : TriangleAlertIcon;

  return (
    <ChatColumnBannerFrame>
      <Alert
        className={cn(
          EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
          onDismiss && !isDurablyUnavailable ? "pr-10" : undefined,
        )}
        variant={isError ? "error" : "warning"}
      >
        <Icon className={NOTIFICATION_ICON_CLASS_NAME} />
        <AlertTitle className="font-normal text-[var(--notification-fg)]">{title}</AlertTitle>
        <AlertDescription className="line-clamp-3 text-[var(--notification-fg)]/72" title={message}>
          {message}
        </AlertDescription>
        {isDurablyUnavailable && onManageProviders ? (
          <AlertAction className="items-center">
            <Button
              size="xs"
              variant="outline"
              onClick={() => runProviderHealthRecoveryAction(onManageProviders)}
            >
              {t("provider.health.manageProviders")}
            </Button>
          </AlertAction>
        ) : onDismiss && !isDurablyUnavailable ? (
          <AlertAction className="absolute top-2 right-2">
            <IconButton
              className="size-6 rounded-full text-[var(--notification-fg)]/65 hover:bg-[var(--notification-fg)]/10 hover:text-[var(--notification-fg)] focus-visible:ring-[var(--notification-fg)]/35 sm:size-6"
              label={t("provider.health.dismiss")}
              title={t("provider.health.dismiss")}
              onClick={onDismiss}
            >
              <XIcon className="size-4" />
            </IconButton>
          </AlertAction>
        ) : null}
      </Alert>
    </ChatColumnBannerFrame>
  );
};
