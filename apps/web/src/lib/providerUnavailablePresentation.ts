// FILE: providerUnavailablePresentation.ts
// Purpose: Converts provider send-block truth into safe localized product copy.
// Layer: Shared web presentation logic

import {
  mossDefaultManagedInstanceIdForProvider,
  providerStatusDisplayLabel,
  resolveProviderSendBlockedReasonKind,
  type ProviderSendAvailability,
} from "./providerAvailability";
import { formatMossTranslation, translateMoss } from "../localization";
import type { MossLocaleCode } from "../uiLocale";

/** A signed-out agent the Moss account can serve instead (it has a Moss lane). */
export function mossCanServeSignedOutProvider(
  input: Pick<ProviderSendAvailability, "provider" | "status" | "unavailableReason">,
): boolean {
  const mossInstanceId = mossDefaultManagedInstanceIdForProvider(input.provider);
  return (
    resolveProviderSendBlockedReasonKind(input) === "unauthenticated" &&
    mossInstanceId !== undefined &&
    (input.status?.instanceId ?? input.provider) !== mossInstanceId
  );
}

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
      // Agents Moss's gateway serves can switch to the Moss account instead of signing in.
      return formatMossTranslation(
        locale,
        mossCanServeSignedOutProvider(input)
          ? "provider.send.blocked.unauthenticatedWithMoss"
          : "provider.send.blocked.unauthenticated",
        { provider: providerLabel },
      );
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
