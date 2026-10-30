import type { MossImageJob } from "~/lib/mossImagesClient";
import { formatMediaOriginalCost } from "~/lib/mossMediaMoney";

export function MossImageBilling({ job }: { readonly job: MossImageJob }) {
  const billing = job.billing;
  const packageCost = billing?.walletKind === "package_cost_v1";
  const media = packageCost || billing?.walletKind === "media_cost_v1";
  const actualCost = billing?.actualCostNano;
  return (
    <>
      {media ? (
        <>
          {job.billingStatus === "captured" && billing.chargedNanoCny !== undefined ? (
            <span>
              {packageCost
                ? "已计入套餐用量"
                : `历史费用 ¥${formatMediaOriginalCost(billing.chargedNanoCny)}`}
            </span>
          ) : job.billingStatus === "exempt" ? (
            <span>本次无需扣费</span>
          ) : (
            job.billingStatus !== "released" && <span>费用待结算</span>
          )}
          {(job.billingStatus === "pending" || job.billingStatus === "unknown") &&
            billing.reservedNanoCny !== undefined && (
              <span>
                {packageCost
                  ? "套餐额度已预留"
                  : `历史预留 ¥${formatMediaOriginalCost(billing.reservedNanoCny)}`}
              </span>
            )}
          {(billing.fxVersion || (Number.isSafeInteger(actualCost) && billing.currency)) && (
            <details className="text-ui-xs">
              <summary className="cursor-pointer">费用明细</summary>
              {billing.currency &&
                typeof actualCost === "number" &&
                Number.isSafeInteger(actualCost) &&
                actualCost >= 0 && (
                  <p>
                    供应商实际成本 {formatMediaOriginalCost(String(actualCost))} {billing.currency}
                  </p>
                )}
              {billing.fxVersion && <p>换算版本 {billing.fxVersion}</p>}
            </details>
          )}
        </>
      ) : (
        <>
          {typeof billing?.creditsCharged === "number" ? (
            <span>扣除 {billing.creditsCharged.toLocaleString()} 体验积分</span>
          ) : (
            job.billingStatus === "captured" && <span>费用已结算</span>
          )}
          {job.billingStatus === "pending" && typeof billing?.creditsReserved === "number" && (
            <span>预留 {billing.creditsReserved.toLocaleString()} 体验积分</span>
          )}
        </>
      )}
      {job.billingStatus === "released" && <span>费用已释放</span>}
    </>
  );
}
