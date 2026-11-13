// FILE: AccountSignInRequestDialog.tsx
// Purpose: Asks the person at this computer whether a phone signed in to their Moss account
//   may use it, with the check code the phone must also be showing. "Don't allow" is the
//   focused, safe choice. Only the two buttons close it (Escape and clicks outside do
//   nothing); a request that lapses closes it on its own. When a different request comes on
//   screen, both buttons wait a moment, so a click meant for the previous one cannot land on it.
// Layer: Auth UI
// Exports: AccountSignInRequestDialog, ACCOUNT_SIGN_IN_SETTLE_MS
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "~/localization";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  accountSignInSecondsLeft,
  accountSignInTitle,
  groupedCheckCode,
  type ShownAccountSignInRequest,
} from "./accountSignInRequestModel";

/** How long both buttons stay inactive after the request on screen changes. */
export const ACCOUNT_SIGN_IN_SETTLE_MS = 1000;

export function AccountSignInRequestDialog(props: {
  readonly request: ShownAccountSignInRequest | null;
  /** Other phones waiting behind this one. */
  readonly othersWaiting: number;
  readonly nowMs: number;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly onAllow: (requestId: string) => void;
  readonly onDeny: (requestId: string) => void;
}) {
  const { t, format } = useTranslation();
  const denyRef = useRef<HTMLButtonElement>(null);
  // The dialog keeps its last request while it animates closed, so the text does not vanish
  // a frame before the popup does.
  const [retained, setRetained] = useState(props.request);
  useEffect(() => {
    if (props.request !== null) setRetained(props.request);
  }, [props.request]);
  const shownId = props.request?.requestId ?? null;
  const [settledFor, setSettledFor] = useState<string | null>(null);
  useEffect(() => {
    if (shownId === null) return;
    const timer = window.setTimeout(() => setSettledFor(shownId), ACCOUNT_SIGN_IN_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [shownId]);
  // Inactive while answering, and for a moment after a different request comes on screen.
  // aria-disabled keeps "Don't allow" focusable, so the safe choice keeps the focus.
  const inactive = props.busy || shownId === null || settledFor !== shownId;
  const open = props.request !== null;
  const request = props.request ?? retained;
  const title = request ? accountSignInTitle(request) : null;
  return (
    <AlertDialog
      open={open}
      // A security decision: no keyboard or pointer shortcut answers it, and none dismisses it.
      onOpenChange={() => undefined}
    >
      <AlertDialogPopup initialFocus={denyRef} data-testid="account-sign-in-request">
        {request && title ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {title.key === "auth.accountSignIn.title"
                  ? format(title.key, { device: title.device })
                  : t(title.key)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {request.accountLabel
                  ? format("auth.accountSignIn.description", { account: request.accountLabel })
                  : t("auth.accountSignIn.descriptionNoAccount")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-ui-gap-xs px-4 py-2">
              <div className="flex flex-col items-center gap-1 rounded-card bg-foreground/5 px-4 py-3">
                <span className="text-ui-sm text-muted-foreground">
                  {t("auth.accountSignIn.codeLabel")}
                </span>
                <span
                  className="font-medium text-title tabular-nums"
                  aria-label={request.checkCode}
                  data-testid="account-sign-in-check-code"
                >
                  {groupedCheckCode(request.checkCode)}
                </span>
              </div>
              <p className="text-ui text-foreground">{t("auth.accountSignIn.codeHint")}</p>
              <p className="text-ui-sm text-muted-foreground">
                {format("auth.accountSignIn.expires", {
                  seconds: String(accountSignInSecondsLeft(request, props.nowMs)),
                })}
                {props.othersWaiting > 0
                  ? ` ${format("auth.accountSignIn.moreWaiting", {
                      count: String(props.othersWaiting),
                    })}`
                  : null}
              </p>
              {props.failed ? (
                <p className="text-ui-sm text-destructive" role="alert">
                  {t("auth.accountSignIn.failed")}
                </p>
              ) : null}
            </div>
            <AlertDialogFooter>
              <Button
                ref={denyRef}
                variant="outline"
                aria-disabled={inactive}
                className={INACTIVE_CLASS}
                onClick={() => {
                  if (!inactive) props.onDeny(request.requestId);
                }}
              >
                {t("auth.accountSignIn.deny")}
              </Button>
              <Button
                aria-disabled={inactive}
                className={INACTIVE_CLASS}
                onClick={() => {
                  if (!inactive) props.onAllow(request.requestId);
                }}
              >
                {t("auth.accountSignIn.allow")}
              </Button>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const INACTIVE_CLASS = "aria-disabled:pointer-events-none aria-disabled:opacity-64";
