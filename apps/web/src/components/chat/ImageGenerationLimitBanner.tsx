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
        d="M5.05 15.45a7 7 0 1 1 9.9 0"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
      <path d="M10 11.5l2.9-3.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
      <circle cx="10" cy="11.5" r="1.25" fill="currentColor" />
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
