// FILE: useMossQuotaSummary.ts
// Purpose: The Moss account's remaining quota in one place, for every surface that names it
//          (Environment panel, the sidebar ring, Settings → Usage).
// Layer: React hook over the Moss server queries

import { useQuery } from "@tanstack/react-query";

import { useTranslation } from "~/localization";
import { mossQuotaRemainingPercent } from "~/components/settings/MossBillingSettingsPanel";
import { isMossPayQuotaUnlimited, resolveMossPayQuotaAccountIdentity } from "./MossPayPanel";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "./mossServerReactQuery";

export interface MossQuotaSummary {
  /** Signed in to Moss (phone or account), so a quota exists to read. */
  readonly signedIn: boolean;
  readonly unlimited: boolean;
  /** Remaining share of the first limited window, 0–100; null while unknown or unlimited. */
  readonly remainingPercent: number | null;
  /** "剩余 96%" / "不限量", or null while unknown. */
  readonly status: string | null;
}

export function useMossQuotaSummary(): MossQuotaSummary {
  const { format, t } = useTranslation();
  const phoneQuery = useQuery(serverMossAccountSessionQueryOptions());
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const accountIdentity = resolveMossPayQuotaAccountIdentity(phoneQuery.data, accountQuery.data);
  const quotaQuery = useQuery(
    serverMossPayQuotaQueryOptions({ enabled: accountIdentity !== null, accountIdentity }),
  );
  const quota = quotaQuery.data;
  const unlimited = quota ? isMossPayQuotaUnlimited(quota) : false;
  const quotaWindow = quota?.usageLimits.find((limit) => limit.limit !== null);
  const remainingPercent =
    quotaWindow && !unlimited
      ? mossQuotaRemainingPercent(quotaWindow.used, quotaWindow.limit)
      : null;
  const status = unlimited
    ? t("mossPay.quota.unlimited")
    : remainingPercent !== null
      ? format("mossPay.quota.remaining", { value: `${remainingPercent}%` })
      : null;
  return { signedIn: accountIdentity !== null, unlimited, remainingPercent, status };
}
