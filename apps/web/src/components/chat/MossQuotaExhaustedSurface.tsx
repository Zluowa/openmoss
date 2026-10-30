import { useMemo, useState } from "react";

import { RefreshCwIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import type { MossQuotaAdmission } from "~/lib/mossQuotaAdmission";
import { Button } from "~/components/ui/button";

type ExhaustedDecision = Extract<MossQuotaAdmission, { readonly kind: "exhausted" }>;

export function MossQuotaExhaustedSurface({
  decision,
  onOpenPlans,
}: {
  readonly decision: ExhaustedDecision;
  readonly onOpenPlans: () => void;
}) {
  const { format, locale, t } = useTranslation();
  const [open, setOpen] = useState(true);
  const formattedResetAt = useMemo(() => {
    if (decision.resetAt === null) return null;
    const resetMs = Date.parse(decision.resetAt);
    if (!Number.isFinite(resetMs)) return null;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(resetMs));
  }, [decision.resetAt, locale]);
  if (!open) {
    return null;
  }

  return (
    <section
      aria-live="polite"
      className="relative isolate flex w-full min-w-0 overflow-hidden rounded-composer border border-primary-outline bg-surface py-2 ps-3 pe-2 text-ui-lg text-pretty shadow-xs"
      data-testid="moss-quota-exhausted-banner"
      role="status"
    >
      <div className="absolute inset-0 -z-10 bg-primary-soft" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <RefreshCwIcon className="icon-sm mt-0.5 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-ui-lg leading-5 font-bold" id="moss-quota-exhausted-title">
            {t("mossQuota.exhausted.title")}
          </h2>
          <p className="whitespace-pre-wrap text-ui-lg leading-[18px] font-normal text-codex-description">
            {t("mossQuota.exhausted.description")}
          </p>
          {formattedResetAt !== null ? (
            <p className="text-ui-sm text-codex-description">
              {format("mossQuota.exhausted.reset", { resetAt: formattedResetAt })}
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              {t("mossQuota.exhausted.dismiss")}
            </Button>
            <Button
              data-testid="moss-quota-open-plans"
              onClick={onOpenPlans}
              size="sm"
              type="button"
            >
              {t("mossQuota.exhausted.openPlans")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
