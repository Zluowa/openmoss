import type { MossPayOrder } from "@synara/contracts";
import { isMossPayOrderSettled } from "@synara/contracts";
import type { ReactNode } from "react";
import { formatMossPayOrderAmount, QrCode } from "./MossPayPanel";
import { safeMossPayOrderErrorMessage } from "./MossMembershipPage.logic";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { openExternalLink } from "~/lib/linkChips";
import { useTranslation } from "~/localization";

export function MossPayOrderDialog({
  activeOrderNo,
  clearOrder,
  createError,
  order,
  orderError,
  orderIsFetching,
  railKind,
  settled: settledOverride,
  title,
  description,
  hidePayment = false,
  children,
}: {
  readonly activeOrderNo: string | null;
  readonly clearOrder: () => void;
  readonly createError: unknown;
  readonly order: MossPayOrder | undefined;
  readonly orderError: unknown;
  readonly orderIsFetching: boolean;
  readonly railKind: "qr" | "hosted" | null;
  readonly settled?: boolean;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly hidePayment?: boolean;
  readonly children?: ReactNode;
}) {
  const { format, locale, t } = useTranslation();
  const reviewRequired = order?.refundReviewRequired === true;
  const paid = order?.status === "paid";
  const settled =
    !reviewRequired && (settledOverride ?? (order ? isMossPayOrderSettled(order.status) : false));
  const open = Boolean(createError || activeOrderNo);
  const showPayment =
    !reviewRequired && !paid && !hidePayment && !createError && !orderError && !settled;

  if (!open) return null;

  const amount = order ? formatMossPayOrderAmount(order, locale) : null;
  const dialogTitle = reviewRequired
    ? t("mossPay.order.refundReview")
    : paid
      ? t("mossPay.order.fulfillmentPending")
      : createError
        ? t("mossPay.order.createFailed")
        : orderError
          ? t("mossPay.order.statusFailed")
          : settled
            ? t("mossPay.order.paid")
            : order && amount && (railKind === "hosted" || order.checkoutUrl)
              ? format("mossPay.order.stripe", { amount })
              : order && amount
                ? format("mossPay.order.scan", { amount })
                : t("mossPay.order.generatingQr");
  const dialogDescription = reviewRequired
    ? t("mossPay.order.refundReviewDescription")
    : paid
      ? t("mossPay.order.fulfillmentPendingDescription")
      : createError
        ? safeMossPayOrderErrorMessage(createError, locale)
        : orderError
          ? safeMossPayOrderErrorMessage(orderError, locale)
          : settled
            ? t("mossPay.order.received")
            : orderIsFetching
              ? t("mossPay.order.waiting")
              : t("mossPay.order.autoCredit");

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) clearOrder();
      }}
      open={open}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        className="max-w-[380px] gap-0"
        data-testid="moss-membership-order"
      >
        <DialogHeader className="items-center px-12 pt-6 pb-2 text-center">
          <DialogTitle className="text-base">
            {reviewRequired ? dialogTitle : (title ?? dialogTitle)}
          </DialogTitle>
          <DialogDescription className="text-center text-ui-sm">
            {reviewRequired ? dialogDescription : (description ?? dialogDescription)}
          </DialogDescription>
        </DialogHeader>

        {showPayment || children ? (
          <DialogPanel className="flex flex-col items-center px-6 pt-2 pb-6">
            {showPayment &&
              (order && (railKind === "hosted" || order.checkoutUrl) ? (
                <Button
                  className="mt-2 min-w-48 rounded-full"
                  disabled={!order.checkoutUrl}
                  onClick={() => {
                    if (order.checkoutUrl) void openExternalLink(order.checkoutUrl);
                  }}
                >
                  {t("mossPay.order.openStripe")}
                </Button>
              ) : order?.codeUrl ? (
                <QrCode size={220} value={order.codeUrl} />
              ) : (
                <div
                  aria-label={t("mossPay.order.generatingQr")}
                  className="size-[220px] animate-pulse rounded-lg border bg-muted"
                />
              ))}
            {children ? <div className="mt-4 w-full">{children}</div> : null}
          </DialogPanel>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
