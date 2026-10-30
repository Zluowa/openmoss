// FILE: ProviderUsagePanelContent.tsx
// Purpose: Render a provider usage summary panel that can show both classic
// rate-limit rows and archive-derived local usage lines in the same popover.

import type { ProviderKind, ServerCodexResetCredits } from "@synara/contracts";
import { providerUsageLabel } from "@synara/shared/providerUsage";

import { ExternalLinkIcon, TriangleAlertIcon } from "~/lib/icons";
import type { OpenUsageUsageLine } from "~/lib/openUsageRateLimits";
import {
  deriveProviderUsageLearnMoreHref,
  deriveRateLimitLearnMoreHref,
  type ProviderRateLimit,
} from "~/lib/rateLimits";
import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { useAppSettings } from "~/appSettings";

import { ProviderUsageLimitRows } from "./ProviderUsageLimitRows";
import { ProviderUsageLineList } from "./ProviderUsageLineList";
import { ProviderUsageResetCredits } from "./ProviderUsageResetCredits";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";

export { providerUsageLabel };

export function ProviderUsagePanelContent(props: {
  provider: ProviderKind | null | undefined;
  rateLimits: ReadonlyArray<ProviderRateLimit>;
  usageLines?: ReadonlyArray<OpenUsageUsageLine> | undefined;
  notice?: string | null | undefined;
  emptyMessage?: string | null | undefined;
  isLoading?: boolean | undefined;
  learnMoreHref?: string | null | undefined;
  showUsageLines?: boolean | undefined;
  resetCredits?: ServerCodexResetCredits | undefined;
  resetCreditsSurface?: "settings" | "popover" | undefined;
  showTitle?: boolean | undefined;
  showLearnMore?: boolean | undefined;
  className?: string | undefined;
}) {
  const { t } = useTranslation();
  const visibleRows = deriveProviderUsageDisplayRows(props.rateLimits);
  const learnMoreHref =
    props.learnMoreHref ??
    deriveRateLimitLearnMoreHref(props.rateLimits) ??
    deriveProviderUsageLearnMoreHref(props.provider);

  // Limit rows are what the popover is for; everything else waits behind "Details",
  // limited to the sections chosen in Settings → Usage. Without limit rows the details
  // are all there is, so they show directly and the section choices do not apply.
  const collapseDetails = visibleRows.length > 0;
  const hasUsageLines =
    props.showUsageLines !== false && props.usageLines && props.usageLines.length > 0;

  return (
    <div className={cn("space-y-2", props.className)}>
      {props.showTitle !== false ? (
        <div className="text-chat-meta font-medium text-muted-foreground">
          {providerUsageLabel(props.provider)}
        </div>
      ) : null}
      {props.notice ? (
        <p className="flex items-start gap-1.5 text-chat-meta leading-relaxed text-amber-600 dark:text-amber-300/90">
          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{props.notice}</span>
        </p>
      ) : null}
      <ProviderUsageLimitRows rows={visibleRows} surface="popover" />
      {collapseDetails ? (
        <ProviderUsageDetailsDisclosure
          resetCredits={props.resetCredits}
          resetCreditsSurface={props.resetCreditsSurface}
          usageLines={hasUsageLines ? props.usageLines : undefined}
        />
      ) : (
        <>
          {props.resetCredits ? (
            <ProviderUsageResetCredits
              resetCredits={props.resetCredits}
              surface={props.resetCreditsSurface ?? "popover"}
            />
          ) : null}
          {hasUsageLines ? (
            <ProviderUsageLineList lines={props.usageLines ?? []} surface="popover" />
          ) : props.isLoading ? (
            <p className="text-chat-meta leading-relaxed text-muted-foreground">
              {t("settings.usage.scanningLocal")}
            </p>
          ) : (
            <p className="text-chat-meta leading-relaxed text-muted-foreground">
              {props.emptyMessage ?? t("settings.usage.noLocalData")}
            </p>
          )}
        </>
      )}
      {props.showLearnMore === true && learnMoreHref ? (
        <a
          href={learnMoreHref}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 pt-0.5 text-chat-meta text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("settings.usage.learnMore")}
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

// Rendered only when rate-limit rows are present, so the panel itself stays
// usable without an app-settings QueryClient (e.g. static server rendering).
function ProviderUsageDetailsDisclosure(props: {
  resetCredits?: ServerCodexResetCredits | undefined;
  resetCreditsSurface?: "settings" | "popover" | undefined;
  usageLines?: ReadonlyArray<OpenUsageUsageLine> | undefined;
}) {
  const { settings, updateSettings } = useAppSettings();
  const resetCredits =
    props.resetCredits && settings.usagePopoverShowResetCredits ? (
      <ProviderUsageResetCredits
        resetCredits={props.resetCredits}
        surface={props.resetCreditsSurface ?? "popover"}
      />
    ) : null;
  const usageLines =
    props.usageLines && settings.usagePopoverShowUsageLines ? (
      <ProviderUsageLineList lines={props.usageLines} surface="popover" />
    ) : null;
  if (resetCredits === null && usageLines === null) {
    return null;
  }
  const detailsOpen = settings.usageDetailsDefaultOpen;
  return (
    <div>
      <button
        type="button"
        aria-expanded={detailsOpen}
        onClick={() => updateSettings({ usageDetailsDefaultOpen: !detailsOpen })}
        className="flex items-center gap-1 text-chat-meta text-muted-foreground transition-colors hover:text-foreground"
      >
        <DisclosureChevron open={detailsOpen} className="size-3" />
        Details
      </button>
      <DisclosureRegion open={detailsOpen} contentClassName="space-y-2 pt-2">
        {resetCredits}
        {usageLines}
      </DisclosureRegion>
    </div>
  );
}
