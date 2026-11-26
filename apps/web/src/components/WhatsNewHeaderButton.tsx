// FILE: WhatsNewHeaderButton.tsx
// Purpose: Quiet post-update "What's new" button mounted in the top-right header slot,
//          aligned with Claude Desktop's ghost accent button. Never auto-opens a modal;
//          clicking opens MossWhatsNewDialog and marks the current version seen.
// Layer: Top-bar chrome control

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { useMossWhatsNew } from "~/whatsNew/useMossWhatsNew";
import type { MossRelease } from "~/whatsNew/mossReleases";

export interface WhatsNewHeaderButtonProps {
  readonly currentVersion?: string;
  readonly releases?: readonly MossRelease[];
  readonly className?: string;
}

export function WhatsNewHeaderButton({
  currentVersion,
  releases,
  className,
}: WhatsNewHeaderButtonProps) {
  const { t } = useTranslation();
  const { showButton, openDialog } = useMossWhatsNew({
    ...(currentVersion !== undefined ? { currentVersion } : {}),
    ...(releases !== undefined ? { releases } : {}),
  });

  if (!showButton) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-testid="whats-new-header-button"
      className={cn(
        "h-7 shrink-0 px-2 font-medium !text-[var(--color-text-accent)] hover:bg-[var(--color-background-button-secondary-hover)] hover:!text-[var(--color-text-accent)] [-webkit-app-region:no-drag]",
        className,
      )}
      onClick={openDialog}
    >
      {t("whatsNew.header.button")}
    </Button>
  );
}
