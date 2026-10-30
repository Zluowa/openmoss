import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MossImageBilling } from "./MossImageBilling";
import type { MossImageJob } from "~/lib/mossImagesClient";

describe("exact media billing display", () => {
  const job: MossImageJob = {
    jobId: "job",
    status: "succeeded",
    prompt: "image",
    createdAt: "2026-10-10T00:00:00Z",
    modelId: "gpt-image",
    imageUrls: [],
    billingStatus: "pending",
    billing: {
      walletKind: "media_cost_v1",
      chargedNanoCny: "0",
      reservedNanoCny: "1",
      creditsCharged: 0,
    },
  };
  it("does not mistake the pending SQL zero placeholder for a captured charge", () => {
    const html = renderToStaticMarkup(<MossImageBilling job={job} />);
    expect(html).toContain("费用待结算");
    expect(html).toContain("历史预留 ¥0.000000001");
    expect(html).not.toContain("扣除");
  });
  it("shows a tiny captured charge exactly and releases without a charge label", () => {
    expect(
      renderToStaticMarkup(
        <MossImageBilling
          job={{
            ...job,
            billingStatus: "captured",
            billing: { ...job.billing, chargedNanoCny: "1" },
          }}
        />,
      ),
    ).toContain("历史费用 ¥0.000000001");
    const released = renderToStaticMarkup(
      <MossImageBilling job={{ ...job, billingStatus: "released" }} />,
    );
    expect(released).toContain("费用已释放");
    expect(released).not.toContain("扣除");
  });
  it("reports package settlement without selling a separate balance", () => {
    const captured = renderToStaticMarkup(
      <MossImageBilling
        job={{
          ...job,
          billingStatus: "captured",
          billing: { ...job.billing, walletKind: "package_cost_v1", chargedNanoCny: "123000000" },
        }}
      />,
    );
    expect(captured).toContain("已计入套餐用量");
    expect(captured).not.toContain("媒体积分");
    expect(captured).not.toContain("历史费用");
    const pending = renderToStaticMarkup(
      <MossImageBilling
        job={{ ...job, billing: { ...job.billing, walletKind: "package_cost_v1" } }}
      />,
    );
    expect(pending).toContain("套餐额度已预留");
    expect(pending).not.toContain("充值");
  });
});
