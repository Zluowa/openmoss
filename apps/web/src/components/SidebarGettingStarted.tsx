// FILE: SidebarGettingStarted.tsx
// Purpose: Opens actionable guides from the sidebar's getting-started disclosure.
// Layer: Sidebar onboarding UI
import { useState } from "react";

import { useTranslation } from "~/localization";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const ITEM_KEYS = [
  "sidebar.gettingStarted.dailyUpdate",
  "sidebar.gettingStarted.catchUpLinear",
  "sidebar.gettingStarted.reviewPlans",
] as const;

export function SidebarGettingStarted({
  onOpenAutomations,
  onOpenConnectors,
  onCreateChat,
}: {
  readonly onOpenAutomations: () => void;
  readonly onOpenConnectors: () => void;
  readonly onCreateChat: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const guides = [
    {
      description: t("sidebar.gettingStarted.dailyUpdate.description"),
      action: t("sidebar.gettingStarted.dailyUpdate.action"),
      run: onOpenAutomations,
    },
    {
      description: t("sidebar.gettingStarted.catchUpLinear.description"),
      action: t("sidebar.gettingStarted.catchUpLinear.action"),
      run: onOpenConnectors,
    },
    {
      description: t("sidebar.gettingStarted.reviewPlans.description"),
      action: t("sidebar.gettingStarted.reviewPlans.action"),
      run: onCreateChat,
    },
  ];
  return (
    <div className="px-1.5 pt-1 pb-2" data-sidebar-getting-started="true">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate">{t("sidebar.gettingStarted")}</span>
        <DisclosureChevron open={open} className="text-muted-foreground/70" />
      </button>
      <DisclosureRegion open={open}>
        <ul className="space-y-0.5 px-1 pt-0.5 pb-1">
          {ITEM_KEYS.map((key, index) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => setSelected(index)}
                aria-label={t(key)}
                aria-haspopup="dialog"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-ui-sm text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground focus-visible:outline focus-visible:outline-ring"
              >
                <span
                  aria-hidden="true"
                  className="size-3.5 shrink-0 rounded-full border border-current/45"
                />
                <span className="min-w-0 truncate">{t(key)}</span>
              </button>
            </li>
          ))}
        </ul>
      </DisclosureRegion>
      <Dialog
        open={selected !== null}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
      >
        <DialogPopup showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{selected !== null ? t(ITEM_KEYS[selected]!) : ""}</DialogTitle>
            <DialogDescription>
              {selected !== null ? guides[selected]!.description : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              {t("dialog.close")}
            </Button>
            <Button
              onClick={() => {
                const guide = selected !== null ? guides[selected] : null;
                setSelected(null);
                guide?.run();
              }}
            >
              {selected !== null ? guides[selected]!.action : ""}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
