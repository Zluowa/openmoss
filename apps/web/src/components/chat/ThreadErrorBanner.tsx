// FILE: ThreadErrorBanner.tsx
// Purpose: Presents runtime errors and persistent turn failures with recovery actions.
// Layer: Chat status presentation
// Exports: ThreadErrorBanner
//
// Live session errors sit above the transcript; durable turn failures reuse
// the same banner inside the timeline. A message that did not start shows here
// too, as one sentence and its one action (`oneAction`). Threads off screen
// still toast live session errors via useThreadErrorToast.

import { isProviderDeliveryBlockDetail } from "@moss/shared/providerDeliveryBlock";
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
import { openSettings as openSettingsDialog } from "~/settingsDialogStore";

type ThreadErrorBannerProps = {
  error: string | null;
  title?: string;
  onContinue?: () => void;
  onChangeModel?: () => void;
  recoveryDisabled?: boolean;
  /** Sends the request again; offered only for failures Moss will not resend by itself. */
  onRetry?: () => void;
  onDismiss?: () => void;
  /** Recovery action offered only when the error is a provider-delivery quarantine. */
  onUnblock?: () => void;
  unblocking?: boolean;
  className?: string;
  /**
   * A failed message's row: the sentence already decided for it and the one action that
   * changes it. Nothing else is offered (no copy, no details): the cause is the whole story.
   */
  oneAction?: { readonly label: string; readonly onAction: () => void } | null;
};

export function ThreadErrorBanner(props: ThreadErrorBannerProps) {
  if (!props.error) return null;
  if (props.oneAction !== undefined) {
    return (
      <Alert
        variant="error"
        data-failure-row=""
        data-error-surface="failure-row"
        className={cn("w-full max-w-[36rem] shadow-sm", props.className)}
      >
        <CircleAlertIcon />
        <AlertDescription className="min-w-0">
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{props.error}</p>
          {props.oneAction ? (
            <div className="flex flex-wrap items-center gap-1">
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={props.recoveryDisabled}
                onClick={props.oneAction.onAction}
              >
                {props.oneAction.label}
              </Button>
            </div>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
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
    let rafId: number | null = null;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(() => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        measure();
      });
    });
    observer.observe(node);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [error, expanded]);
  const canUnblock = onUnblock !== undefined && isProviderDeliveryBlockDetail(error);
  const presentation = resolveThreadErrorPresentation(error, locale);
  const displayError = presentation.title;
  const canRetry = onRetry !== undefined && presentation.retryable === true;
  const changeModelFirst = presentation.changeModelFirst === true;
  const requiresReauth = presentation.recoveryAction === "manage-providers" && !canRetry;
  const showContinue = onContinue !== undefined && !requiresReauth;
  const showChangeModel = onChangeModel !== undefined && (showContinue || requiresReauth);
  return (
    <Alert
      variant="error"
      data-error-surface="thread-error"
      className={cn("w-full max-w-[36rem] shadow-sm", className)}
    >
      <CircleAlertIcon />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription className="min-w-0">
        <p
          ref={textRef}
          id={detailsId}
          className={cn(
            "whitespace-pre-wrap [overflow-wrap:anywhere]",
            // Room for the full sentence in a narrow column beside the dock (N2-5); only a
            // long raw error still folds behind 显示详情.
            expanded ? "max-h-60 overflow-y-auto" : "line-clamp-6",
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
              onClick={() => openSettingsDialog({ section: "providers" })}
            >
              {t("chat.error.openProviderSettings")}
            </Button>
          ) : null}
          {showContinue && showChangeModel && changeModelFirst ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={recoveryDisabled}
              onClick={onChangeModel}
            >
              {t("chat.error.changeModel")}
            </Button>
          ) : null}
          {showContinue ? (
            <Button
              size="xs"
              variant={changeModelFirst && showChangeModel ? "outline" : "destructive-outline"}
              disabled={recoveryDisabled}
              onClick={onContinue}
            >
              {t("chat.error.continueTask")}
            </Button>
          ) : null}
          {showChangeModel && (!showContinue || !changeModelFirst) ? (
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
            <XIcon className="size-4" />
          </IconButton>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
