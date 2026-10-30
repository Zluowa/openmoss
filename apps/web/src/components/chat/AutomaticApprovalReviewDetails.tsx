// FILE: AutomaticApprovalReviewDetails.tsx
// Purpose: Render one bounded automatic approval-review disclosure inside an MCP row.
// Layer: Chat presentation component
// Exports: AutomaticApprovalReviewDetails

import { useId, useState } from "react";

import type { AutomaticApprovalReviewUpdatePayload } from "@synara/contracts";

import { ChevronRightIcon } from "~/lib/icons";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { DisclosureRegion } from "../ui/DisclosureRegion";

function reviewTitle(
  review: AutomaticApprovalReviewUpdatePayload,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (review.status === "inProgress") {
    return t("localConversation.automaticApprovalReview.inProgressTitle");
  }
  if (review.status === "approved") {
    return t("localConversation.automaticApprovalReview.approvedTitle");
  }
  if (review.status === "denied") {
    return review.riskLevel === "high"
      ? t("localConversation.automaticApprovalReview.deniedHighRiskTitle")
      : t("localConversation.automaticApprovalReview.deniedTitle");
  }
  if (review.status === "timedOut") {
    return t("localConversation.automaticApprovalReview.timedOutTitle");
  }
  return t("localConversation.automaticApprovalReview.abortedTitle");
}

function reviewFallback(
  review: AutomaticApprovalReviewUpdatePayload,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (review.status === "inProgress") {
    return t("localConversation.automaticApprovalReview.inProgressFallback");
  }
  if (review.status === "aborted") {
    return t("localConversation.automaticApprovalReview.abortedFallback");
  }
  if (review.status === "timedOut") {
    return t("localConversation.automaticApprovalReview.timedOutFallback");
  }
  return t("localConversation.automaticApprovalReview.terminalFallback");
}

export function AutomaticApprovalReviewDetails({
  review,
}: {
  review: AutomaticApprovalReviewUpdatePayload;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const bodyId = `automatic-approval-review-body-${useId().replace(/[^a-zA-Z0-9-]/gu, "")}`;
  const title = reviewTitle(review, t);
  const rationale =
    typeof review.rationale === "string" && review.rationale.trim().length > 0
      ? review.rationale.trim()
      : reviewFallback(review, t);
  const isHighRiskDenied = review.status === "denied" && review.riskLevel === "high";

  return (
    <div
      className="flex min-w-0 flex-col pt-1"
      data-automatic-approval-review={review.reviewId}
      data-automatic-approval-review-status={review.status}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        className="group/automatic-approval-review inline-flex w-fit max-w-full cursor-interaction items-center gap-1.5 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-automatic-approval-review-trigger="true"
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className={cn(
            "min-w-0 truncate",
            isHighRiskDenied
              ? "text-warning"
              : "text-codex-description/80 group-hover/automatic-approval-review:text-default group-focus-within/automatic-approval-review:text-default",
            review.status === "inProgress" && "shimmer motion-reduce:shimmer-none",
          )}
          data-automatic-approval-review-title="true"
        >
          {title}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            disclosureChevronClassName(open, "icon-2xs shrink-0 text-tertiary"),
            "opacity-0 [@media(hover:hover)]:group-hover/automatic-approval-review:opacity-100 group-focus-within/automatic-approval-review:opacity-100",
            open && "opacity-100",
          )}
          data-automatic-approval-review-chevron="true"
        />
      </button>
      <div id={bodyId} data-automatic-approval-review-body-wrapper="true">
        <DisclosureRegion open={open} className="min-w-0 max-w-full">
          <p
            className="max-w-[80ch] pt-1 text-size-chat leading-relaxed whitespace-pre-wrap text-text/60 !text-foreground/70 break-words"
            data-automatic-approval-review-rationale="true"
          >
            {rationale}
          </p>
        </DisclosureRegion>
      </div>
    </div>
  );
}
