// Codex sidebarOnboardingChecklist (`sidebar-onboarding-checklist.electron`):
// a footer disclosure titled "Getting started" with "{progressCount} of {totalCount}".
import { useState } from "react";

import { useTranslation } from "~/localization";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";

const ITEM_KEYS = [
  "sidebar.gettingStarted.dailyUpdate",
  "sidebar.gettingStarted.catchUpLinear",
  "sidebar.gettingStarted.reviewPlans",
] as const;

export function SidebarGettingStarted() {
  const { format, t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="px-1.5 pt-1 pb-2" data-sidebar-getting-started="true">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate">{t("sidebar.gettingStarted")}</span>
        <span className="shrink-0 tabular-nums text-ui-xs text-muted-foreground/70">
          {format("sidebar.gettingStarted.progress", { progressCount: 0, totalCount: 3 })}
        </span>
        <DisclosureChevron open={open} className="text-muted-foreground/70" />
      </button>
      <DisclosureRegion open={open}>
        <ul className="space-y-0.5 px-1 pt-0.5 pb-1">
          {ITEM_KEYS.map((key) => (
            <li key={key}>
              <span className="flex items-center gap-2 rounded-md px-2 py-1 text-ui-sm text-muted-foreground/80">
                <span
                  aria-hidden="true"
                  className="size-3.5 shrink-0 rounded-full border border-current/45"
                />
                <span className="min-w-0 truncate">{t(key)}</span>
              </span>
            </li>
          ))}
        </ul>
      </DisclosureRegion>
    </div>
  );
}
