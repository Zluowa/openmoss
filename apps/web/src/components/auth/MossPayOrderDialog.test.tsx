import type { ReactNode } from "react";
import type { MossPayOrder } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MossPayOrderDialog } from "./MossPayOrderDialog";

// Replace only portal/layout plumbing; exercise the real dialog's money state
// and payment controls in deterministic server rendering without external APIs.
vi.mock("~/components/ui/dialog", () => {
  const container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: container,
    DialogDescription: container,
    DialogHeader: container,
    DialogPanel: container,
    DialogPopup: container,
    DialogTitle: container,
  };
});
vi.mock("~/localization", () => ({
  useTranslation: () => ({ locale: "en", t: (key: string) => key, format: (key: string) => key }),
}));
vi.mock("./MossPayPanel", () => ({
  formatMossPayOrderAmount: () => "CNY 49",
  QrCode: () => <div>fixture-qr-code</div>,
}));

function renderOrder(
  change: Partial<MossPayOrder>,
  overrides: { settled?: boolean; title?: string } = {},
) {
  return renderToStaticMarkup(
    <MossPayOrderDialog
      activeOrderNo="MOSSplan1"
      clearOrder={() => {}}
      createError={null}
      order={{
        outTradeNo: "MOSSplan1",
        orderType: "plan",
        itemCode: "basic",
        amountCny: 4900,
        amountMinor: 4900,
        currency: "CNY",
        status: "pending",
        codeUrl: "weixin://fixture",
        checkoutUrl: null,
        ...change,
      }}
      orderError={null}
      orderIsFetching={false}
      railKind="qr"
      {...overrides}
    />,
  );
}
describe("membership payment dialog", () => {
  it("prioritizes manual refund review over fulfilled status and caller success overrides", () => {
    const html = renderOrder(
      { status: "fulfilled", refundReviewRequired: true },
      { settled: true, title: "purchase-applied" },
    );
    expect(html).toContain("mossPay.order.refundReview");
    expect(html).toContain("mossPay.order.refundReviewDescription");
    expect(html).not.toContain("purchase-applied");
    expect(html).not.toContain("mossPay.order.received");
    expect(html).not.toContain("fixture-qr-code");
  });
  it("hides payment after receipt while waiting for actual fulfillment", () => {
    const html = renderOrder({ status: "paid" });
    expect(html).toContain("mossPay.order.fulfillmentPending");
    expect(html).not.toContain("mossPay.order.received");
    expect(html).not.toContain("fixture-qr-code");
  });
  it("continues to show payable pending orders and unreviewed fulfilled receipts", () => {
    expect(renderOrder({ status: "pending" })).toContain("fixture-qr-code");
    expect(renderOrder({ status: "fulfilled" })).toContain("mossPay.order.received");
  });
});
