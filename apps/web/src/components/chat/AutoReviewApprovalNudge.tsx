// FILE: AutoReviewApprovalNudge.tsx
// Purpose: Standalone Codex-style offer to enable Auto-review from an approval flow.

import { useRef, useState, type FormEvent } from "react";

import { CentralIcon } from "~/lib/central-icons";
import { useTranslation } from "~/localization";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";
import { cn } from "~/lib/utils";

export const AUTO_REVIEW_LEARN_MORE_URL =
  "https://developers.openai.com/codex/concepts/sandboxing/auto-review";

export interface AutoReviewApprovalNudgeProps {
  /** The hosting approval flow persists the dismissal for this conversation. */
  onDismiss: () => void;
  /** Persist guardian/auto-review mode; reject on failure to keep the offer retryable. */
  onEnable: () => Promise<void>;
}

export function AutoReviewApprovalNudge(props: AutoReviewApprovalNudgeProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const enabling = useRef(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (enabling.current) return;
    enabling.current = true;
    setPending(true);
    try {
      await props.onEnable();
    } catch {
      toastManager.add({
        type: "error",
        title: t("approvalRequest.autoReviewNudge.enableFailed"),
      });
    } finally {
      enabling.current = false;
      setPending(false);
    }
  };

  return (
    <div
      className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden")}
      data-testid="auto-review-approval-nudge"
    >
      <form className="flex flex-col" onSubmit={handleSubmit}>
        <div className="flex flex-col gap-5 px-4 pt-4 pb-5">
          <div className="flex items-center gap-2 text-ui-lg text-codex-description">
            <CentralIcon name="shield-code" className="icon-sm size-4 shrink-0" />
            <span>{t("approvalRequest.autoReviewNudge.title")}</span>
          </div>
          <div className="text-base leading-6">
            {t("approvalRequest.autoReviewNudge.description")}{" "}
            <a
              className="cursor-interaction rounded-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
              href={AUTO_REVIEW_LEARN_MORE_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("approvalRequest.autoReviewNudge.learnMore")}
            </a>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/50 px-3 py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={props.onDismiss}
          >
            {t("approvalRequest.autoReviewNudge.keepManual")}
          </Button>
          <Button autoFocus type="submit" size="sm" disabled={pending}>
            {t("approvalRequest.autoReviewNudge.enable")}
            <kbd className="rounded border border-current/15 px-1 py-0.5 text-ui-2xs leading-none opacity-70">
              ⏎
            </kbd>
          </Button>
        </div>
      </form>
    </div>
  );
}
