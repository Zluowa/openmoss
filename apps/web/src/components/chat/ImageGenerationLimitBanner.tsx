// FILE: ImageGenerationLimitBanner.tsx
// Purpose: Render the dedicated above-composer image-generation usage-limit surface.
// Layer: Chat composer UI
// Exports: ImageGenerationLimitBanner

import { useId } from "react";

import { useTranslation, type TranslationKey } from "~/localization";
import { Button } from "../ui/button";
import {
  formatImageGenerationResetDate,
  type ImageGenerationLimitFailure,
  type ImageGenerationLimitPresentation,
} from "./imageGenerationLimit.logic";
import { TranscriptNotice } from "./TranscriptNotice";

const MESSAGE_KEYS: Record<
  ImageGenerationLimitPresentation["variant"],
  { later: TranslationKey; at: TranslationKey }
> = {
  "upgrade-plus": {
    later: "chat.imageGenerationLimit.message.upgradePlus",
    at: "chat.imageGenerationLimit.message.upgradePlusAt",
  },
  "upgrade-pro": {
    later: "chat.imageGenerationLimit.message.upgradePro",
    at: "chat.imageGenerationLimit.message.upgradeProAt",
  },
  "add-credits": {
    later: "chat.imageGenerationLimit.message.addCredits",
    at: "chat.imageGenerationLimit.message.addCreditsAt",
  },
  retry: {
    later: "chat.imageGenerationLimit.message.retry",
    at: "chat.imageGenerationLimit.message.retryAt",
  },
  managed: {
    later: "chat.imageGenerationLimit.message.managed",
    at: "chat.imageGenerationLimit.message.managedAt",
  },
};

function UsageGaugeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="icon-sm shrink-0 max-[400px]:hidden"
      fill="none"
      height="20"
      viewBox="0 0 20 20"
      width="20"
    >
      <path
        d="M10.8343 12.0693C10.0371 12.5295 9.01783 12.2564 8.55759 11.4592C8.09735 10.6621 8.37048 9.64276 9.16763 9.18253C10.1299 8.62697 14.0533 7.64478 14.3311 8.1259C14.6089 8.60703 11.7966 11.5137 10.8343 12.0693Z"
        fill="currentColor"
      />
      <path
        d="M16.585 10.25C16.585 6.6132 13.6368 3.66504 10 3.66504C6.3632 3.66504 3.41504 6.6132 3.41504 10.25C3.41504 12.4001 4.44494 14.31 6.04102 15.5127L6.36719 15.7432L6.47168 15.8291C6.68974 16.0482 6.73203 16.3973 6.55469 16.665C6.3772 16.9328 6.03875 17.0306 5.75195 16.915L5.63281 16.8516L5.24023 16.5752C3.32482 15.1316 2.08496 12.8355 2.08496 10.25C2.08496 5.87867 5.62867 2.33496 10 2.33496C14.3713 2.33496 17.915 5.87867 17.915 10.25C17.915 13.0079 16.5037 15.4356 14.3672 16.8516L14.248 16.915C13.9612 17.0306 13.6228 16.9328 13.4453 16.665C13.2425 16.3589 13.3267 15.946 13.6328 15.7432L13.959 15.5127C15.5551 14.31 16.585 12.4001 16.585 10.25Z"
        fill="currentColor"
      />
    </svg>
  );
}

function titleKeyForVariant(variant: ImageGenerationLimitPresentation["variant"]): TranslationKey {
  return variant === "managed"
    ? "chat.imageGenerationLimit.title.managed"
    : "chat.imageGenerationLimit.title";
}

function primaryLabelKeyForVariant(
  variant: ImageGenerationLimitPresentation["variant"],
): TranslationKey | null {
  switch (variant) {
    case "upgrade-plus":
    case "upgrade-pro":
      return "chat.imageGenerationLimit.action.upgrade";
    case "add-credits":
      return "chat.imageGenerationLimit.action.addCredits";
    case "managed":
      return "chat.imageGenerationLimit.action.viewUsage";
    default:
      return null;
  }
}

function primaryAriaKeyForVariant(
  variant: ImageGenerationLimitPresentation["variant"],
): TranslationKey | null {
  switch (variant) {
    case "upgrade-plus":
    case "upgrade-pro":
      return "chat.imageGenerationLimit.action.upgradeAria";
    case "add-credits":
      return "chat.imageGenerationLimit.action.addCreditsAria";
    case "managed":
      return "chat.imageGenerationLimit.action.viewUsageAria";
    default:
      return null;
  }
}

export function ImageGenerationLimitBanner({
  failure,
  presentation,
  nowMs,
  onDismiss,
  onPrimaryAction,
}: {
  readonly failure: ImageGenerationLimitFailure;
  readonly presentation: ImageGenerationLimitPresentation;
  readonly nowMs?: number;
  readonly onDismiss: () => void;
  readonly onPrimaryAction?: (() => void) | undefined;
}) {
  const { format, locale, t } = useTranslation();
  const titleId = useId();
  const resetDate = formatImageGenerationResetDate(failure.resetsAt, locale, nowMs);
  const messageKeys = MESSAGE_KEYS[presentation.variant];
  const message = resetDate ? format(messageKeys.at, { resetDate }) : t(messageKeys.later);
  const primaryLabelKey = primaryLabelKeyForVariant(presentation.variant);
  const primaryAriaKey = primaryAriaKeyForVariant(presentation.variant);

  return (
    <TranscriptNotice
      aria-labelledby={titleId}
      className="border-primary-outline text-default items-center gap-4 max-[400px]:items-start max-[400px]:gap-2"
      data-image-generation-limit-identity={failure.failureIdentity}
      data-image-generation-limit-source={presentation.sourceKind}
      data-image-generation-limit-variant={presentation.variant}
      data-testid="image-generation-limit-banner"
      role="status"
    >
      <div className="flex h-full w-full items-center gap-2 max-[400px]:items-start">
        <UsageGaugeIcon />
        <div className="flex min-w-0 grow flex-row items-center justify-between gap-2 max-[400px]:flex-col max-[400px]:items-stretch max-[400px]:gap-2">
          <div className="flex w-full min-w-0 flex-col gap-1 text-ui-lg">
            <p className="text-ui-lg font-bold text-pretty" id={titleId}>
              {t(titleKeyForVariant(presentation.variant))}
            </p>
            <p className="leading-[18px] font-normal text-codex-description">{message}</p>
          </div>
          <div className="flex gap-2 shrink-0 max-[400px]:w-full max-[400px]:shrink max-[400px]:flex-wrap max-[400px]:justify-center">
            {primaryLabelKey && presentation.action && onPrimaryAction ? (
              <Button
                aria-label={primaryAriaKey ? t(primaryAriaKey) : undefined}
                data-testid="image-generation-limit-primary"
                onClick={onPrimaryAction}
                type="button"
                variant="default"
              >
                {t(primaryLabelKey)}
              </Button>
            ) : null}
            <Button
              aria-label={t("chat.imageGenerationLimit.action.dismissAria")}
              data-testid="image-generation-limit-dismiss"
              onClick={onDismiss}
              type="button"
              variant="secondary"
            >
              {t("chat.imageGenerationLimit.action.dismiss")}
            </Button>
          </div>
        </div>
      </div>
    </TranscriptNotice>
  );
}
