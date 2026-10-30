// FILE: ChatEmptyStateHero.tsx
// Purpose: Render the centered empty-state hero for blank transcripts.
// Layer: Chat presentation
// Depends on: the caller-supplied project display name.

import { memo, type ReactNode } from "react";
import { MossLogo } from "~/components/MossLogo";
import { useTranslation } from "~/localization";
import { cn } from "~/lib/utils";

export const ChatEmptyStateHero = memo(function ChatEmptyStateHero({
  projectName,
  heading,
  className,
  shellState,
}: {
  projectName: string | undefined;
  heading?: ReactNode;
  className?: string;
  /** Stable shell state marker used by desktop parity checks. */
  shellState?: string;
}) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "flex max-w-full flex-col items-center gap-6 px-6 text-center select-none",
        className,
      )}
      data-shell-surface="chat-empty-hero"
      data-shell-state={shellState}
    >
      <MossLogo aria-label={t("chat.empty.logoAria")} className="size-12" />

      <div className="flex flex-col items-center gap-0.5">
        <h1
          data-testid="empty-landing-heading"
          className="text-[28px] font-normal leading-tight tracking-normal text-foreground"
        >
          {heading ?? t("chat.empty.buildHeading")}
        </h1>
        {projectName && (
          <span className="max-w-full break-words text-ui-lg text-muted-foreground">
            {projectName}
          </span>
        )}
      </div>
    </div>
  );
});
