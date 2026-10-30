// FILE: providerUnavailablePresentation.ts
// Purpose: Converts provider send-block truth into safe localized product copy.
// Layer: Shared web presentation logic

import {
  providerStatusDisplayLabel,
  resolveProviderSendBlockedReasonKind,
  type ProviderSendAvailability,
} from "./providerAvailability";
import { formatMossTranslation, translateMoss } from "../localization";
import type { MossLocaleCode } from "../uiLocale";

export function localizeProviderSendBlockedReason(
  locale: MossLocaleCode,
  input: Pick<ProviderSendAvailability, "provider" | "status" | "unavailableReason">,
): string {
  const reasonKind = resolveProviderSendBlockedReasonKind(input);
  const providerLabel = providerStatusDisplayLabel(input.status, input.provider);
  switch (reasonKind) {
    case "disabled":
      return translateMoss(locale, "provider.send.blocked.disabled");
    case "unauthenticated":
      return formatMossTranslation(locale, "provider.send.blocked.unauthenticated", {
        provider: providerLabel,
      });
    case "status-loading":
      return translateMoss(locale, "provider.send.blocked.statusLoading");
    case "status-timeout":
      return translateMoss(locale, "provider.send.blocked.statusTimeout");
    case "unavailable":
      return formatMossTranslation(locale, "provider.send.blocked.unavailable", {
        provider: providerLabel,
      });
  }
}
