// FILE: MossQuotaExhaustedSurface.tsx
// Purpose: Offers recovery when the current chat account runs out of usage.
// Layer: Chat composer UI
// Exports: UsageLimitBanner, MossQuotaExhaustedSurface

import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { CircleAlertIcon } from "~/lib/icons";
import { openExternalLink } from "~/lib/linkChips";
import { useTranslation } from "~/localization";

export type UsageLimitBanner = {
  readonly resetAt: string | null;
} & (
  | { readonly lane: "moss" }
  | {
      readonly lane: "personal";
      readonly accountLabel: string;
      readonly usageUrl: string | null;
    }
);

export function MossQuotaExhaustedSurface({
  limit,
  onAction,
}: {
  readonly limit: UsageLimitBanner;
  readonly onAction: () => void;
}) {
  const { format, locale, t } = useTranslation();
  const moss = limit.lane === "moss";
  const resetInstant =
    limit.resetAt && /^\d{4}-\d{2}-\d{2}[T ]/u.test(limit.resetAt)
      ? Date.parse(limit.resetAt)
      : Number.NaN;
  const reset = Number.isFinite(resetInstant)
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        resetInstant,
      )
    : limit.resetAt;
  const usageUrl = !moss ? limit.usageUrl : null;

  return (
    <Alert
      variant="error"
      className="mb-2 gap-y-1.5 overflow-hidden border-border bg-surface px-3 py-2"
      role="status"
      data-testid={moss ? "moss-quota-exhausted-banner" : "personal-usage-limit-banner"}
    >
      <CircleAlertIcon aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 text-ui">
          <strong className="font-medium text-destructive [overflow-wrap:anywhere]">
            {moss
              ? t("mossQuota.exhausted.title")
              : format("chat.usageLimit.personalTitle", { account: limit.accountLabel })}
          </strong>
          {moss ? (
            <span className="text-muted-foreground">{t("mossQuota.exhausted.description")}</span>
          ) : null}
          {reset ? (
            <span className="text-muted-foreground">
              {format("mossQuota.exhausted.reset", { resetAt: reset })}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            className="bg-muted"
            onClick={onAction}
          >
            {moss ? t("mossQuota.exhausted.openPlans") : t("chat.usageLimit.switchToMoss")}
          </Button>
          {usageUrl ? (
            <a
              className="text-ui text-primary underline-offset-2 hover:underline"
              href={usageUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                openExternalLink(usageUrl);
              }}
            >
              {t("chat.usageLimit.providerUsage")}
            </a>
          ) : null}
        </div>
      </div>
    </Alert>
  );
}
