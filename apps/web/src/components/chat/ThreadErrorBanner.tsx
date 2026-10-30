// FILE: ThreadErrorBanner.tsx
// Purpose: Presents runtime errors and persistent turn failures with recovery actions.
// Layer: Chat status presentation
// Exports: ThreadErrorBanner
//
// Live session errors sit above the transcript; durable turn failures reuse
// the same banner inside the timeline. Threads off screen still toast live
// session errors via useThreadErrorToast.

import { isProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { CopyTextButton } from "../ui/copyTextButton";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { cn } from "~/lib/utils";
import { resolveThreadErrorPresentation } from "./threadErrorPresentation";

type ThreadErrorBannerProps = {
  error: string | null;
  title?: string;
  onContinue?: () => void;
  onChangeModel?: () => void;
  recoveryDisabled?: boolean;
  /** Sends the request again; offered only for failures that never reached the provider. */
  onRetry?: () => void;
  onDismiss?: () => void;
  /** Recovery action offered only when the error is a provider-delivery quarantine. */
  onUnblock?: () => void;
  unblocking?: boolean;
  className?: string;
};

export function ThreadErrorBanner(props: ThreadErrorBannerProps) {
  if (!props.error) return null;
  // A different failure starts collapsed, with fresh copy feedback.
  return <ThreadErrorBannerContent key={props.error} {...props} error={props.error} />;
}

function ThreadErrorBannerContent({
  error,
  title,
  onContinue,
  onChangeModel,
  recoveryDisabled,
  onRetry,
  onDismiss,
  onUnblock,
  unblocking,
  className,
}: ThreadErrorBannerProps & { error: string }) {
  const { locale, t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const detailsId = useId();
  // Offer "Show details" only when the collapsed text actually hides something.
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [error, expanded]);
  const canUnblock = onUnblock !== undefined && isProviderDeliveryBlockDetail(error);
  const presentation = resolveThreadErrorPresentation(error, locale);
  const displayError = presentation.title;
  const canRetry = onRetry !== undefined && presentation.retryable === true;
  return (
    <Alert variant="error" className={cn("w-full max-w-[36rem] shadow-sm", className)}>
      <CircleAlertIcon />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription className="min-w-0">
        <p
          ref={textRef}
          id={detailsId}
          className={cn(
            "whitespace-pre-wrap [overflow-wrap:anywhere]",
            expanded ? "max-h-60 overflow-y-auto" : "line-clamp-3",
          )}
          tabIndex={expanded ? 0 : undefined}
          title={displayError}
          data-translation-skip="true"
        >
          {displayError}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {canRetry ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={recoveryDisabled}
              onClick={onRetry}
            >
              {t("chat.error.retry")}
            </Button>
          ) : null}
          {clamped || expanded ? (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded((value) => !value)}
            >
              <DisclosureChevron open={expanded} />
              {expanded ? t("chat.error.hideDetails") : t("chat.error.showDetails")}
            </Button>
          ) : null}
          <CopyTextButton
            text={error}
            label="error"
            copyLabel={t("chat.error.copy")}
            copiedLabel={t("chat.error.copied")}
            copiedText={t("chat.error.copiedShort")}
          />
          {presentation.recoveryAction === "manage-providers" ? (
            <Button
              size="xs"
              variant={canRetry ? "outline" : "destructive-outline"}
              // Loaded on demand: app history binds to the window when imported, and
              // the banner also renders where no browser history exists.
              onClick={() => {
                void import("../../appNavigation").then(({ appHistory }) =>
                  appHistory.push("/settings?section=providers"),
                );
              }}
            >
              {t("chat.error.openProviderSettings")}
            </Button>
          ) : null}
          {onContinue ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={recoveryDisabled}
              onClick={onContinue}
            >
              {t("chat.error.continueTask")}
            </Button>
          ) : null}
          {onContinue && onChangeModel ? (
            <Button size="xs" variant="outline" disabled={recoveryDisabled} onClick={onChangeModel}>
              {t("chat.error.changeModel")}
            </Button>
          ) : null}
          {canUnblock ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={unblocking}
              onClick={() => onUnblock?.()}
            >
              {unblocking ? t("chat.error.unblocking") : t("chat.error.unblockThread")}
            </Button>
          ) : null}
        </div>
      </AlertDescription>
      {onDismiss ? (
        <AlertAction className="items-center">
          <IconButton
            label={t("chat.error.dismiss")}
            className="size-6 text-destructive/60 hover:text-destructive sm:size-6"
            onClick={onDismiss}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
