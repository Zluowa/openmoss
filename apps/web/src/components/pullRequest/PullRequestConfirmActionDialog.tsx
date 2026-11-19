// FILE: PullRequestConfirmActionDialog.tsx
// Purpose: The one confirmation dialog for the irreversible pull request actions (merge,
//          close), shared by the PR detail panel and the Environment panel's PR menu, plus the
//          "copy PR link" helper both surfaces expose next to those actions.
// Layer: Pull request UI
// Depends on: the shared alert dialog, toast manager, and clipboard helper.

import type { PullRequestMergeMethod, PullRequestStack } from "@moss/contracts";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { translateMoss, useTranslation, type TranslationKey } from "~/localization";

export type PullRequestConfirmAction =
  | { kind: "merge"; method: PullRequestMergeMethod }
  | { kind: "close" };

type Translate = (key: TranslationKey) => string;
type Format = (key: TranslationKey, values: Record<string, string | number>) => string;

/** Copies the link and says so; the toast speaks the caller's language (English by default). */
export function copyPullRequestLink(
  url: string,
  t: Translate = (key) => translateMoss("en", key),
): void {
  void copyTextToClipboard(url)
    .then(() => {
      toastManager.add({ type: "success", title: t("codeReview.link.copied") });
    })
    .catch(() => {
      toastManager.add({
        type: "error",
        title: t("codeReview.link.copyFailed"),
        description: t("codeReview.link.copyFailedDetail"),
      });
    });
}

const MERGE_METHOD_WORD_KEYS: Record<PullRequestMergeMethod, TranslationKey> = {
  merge: "codeReview.mergeMethod.merge",
  squash: "codeReview.mergeMethod.squash",
  rebase: "codeReview.mergeMethod.rebase",
};

function confirmTitle(
  action: PullRequestConfirmAction,
  stack: PullRequestStack | null,
  stackMergeTargetCount: number,
  t: Translate,
  format: Format,
): string {
  if (action.kind === "close") return t("codeReview.confirm.closeTitle");
  return stack
    ? format(
        stackMergeTargetCount === 1
          ? "codeReview.confirm.mergeOne"
          : "codeReview.confirm.mergeMany",
        { count: stackMergeTargetCount },
      )
    : t("codeReview.confirm.mergeTitle");
}

function confirmDescription(
  action: PullRequestConfirmAction,
  number: number,
  baseBranch: string | null,
  stack: PullRequestStack | null,
  t: Translate,
  format: Format,
  locale: string,
): string {
  if (action.kind === "close") return format("codeReview.confirm.closeBody", { number });
  // English names the method as GitHub does ("squash"); other languages use their own word.
  const method = locale === "en" ? action.method : t(MERGE_METHOD_WORD_KEYS[action.method]);
  if (stack) {
    return `${format("codeReview.confirm.stackBody", {
      number,
      base: stack.baseBranch,
      method,
    })}${stack.position < stack.size ? t("codeReview.confirm.stackRetarget") : ""}`;
  }
  return baseBranch
    ? format("codeReview.confirm.mergeInto", { number, base: baseBranch, method })
    : format("codeReview.confirm.merge", { number, method });
}

export function PullRequestConfirmActionDialog({
  action,
  number,
  baseBranch = null,
  stack,
  stackMergeTargetCount,
  pending,
  onConfirm,
  onDismiss,
}: {
  /** The action awaiting confirmation; null keeps the dialog closed. */
  action: PullRequestConfirmAction | null;
  number: number;
  baseBranch?: string | null;
  stack: PullRequestStack | null;
  stackMergeTargetCount: number;
  pending: boolean;
  onConfirm: (action: PullRequestConfirmAction) => void;
  onDismiss: () => void;
}) {
  // Keep rendering the last action while the dialog animates out, so the copy does not
  // flip to another action's text once the owner resets `action` to null.
  const [shownAction, setShownAction] = useState(action);
  // Compared by value: owners may build the action object inline on every render.
  if (
    action !== null &&
    (shownAction === null ||
      action.kind !== shownAction.kind ||
      (action.kind === "merge" &&
        shownAction.kind === "merge" &&
        action.method !== shownAction.method))
  ) {
    setShownAction(action);
  }
  const shown = action ?? shownAction;
  const { t, format, locale } = useTranslation();

  return (
    <AlertDialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <AlertDialogPopup>
        {shown ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmTitle(shown, stack, stackMergeTargetCount, t, format)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmDescription(shown, number, baseBranch, stack, t, format, locale)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" size="sm" />}>
                {t("codeReview.cancel")}
              </AlertDialogClose>
              <Button
                size="sm"
                variant={shown.kind === "close" ? "destructive" : "default"}
                disabled={pending}
                onClick={() => {
                  onDismiss();
                  onConfirm(shown);
                }}
              >
                {shown.kind === "close"
                  ? t("codeReview.close")
                  : stack
                    ? t("codeReview.pr.mergeStack")
                    : t("codeReview.pr.merge")}
              </Button>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
