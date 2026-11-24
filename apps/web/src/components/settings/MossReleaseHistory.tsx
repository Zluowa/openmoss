// FILE: MossReleaseHistory.tsx
// Purpose: Moss's own versions, newest first, each folding open to its short list of changes.
//          Shown in place under Settings › 通用 › 更新记录 (not as a second dialog) and inside the
//          stand-alone release history dialog.
// Layer: Settings UI

import { useState } from "react";

import { APP_VERSION } from "~/branding";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { mossReleasesUpTo, type MossRelease } from "~/whatsNew/mossReleases";

export function MossReleaseHistory({
  runningVersion = APP_VERSION,
  releases,
  className,
}: {
  readonly runningVersion?: string;
  readonly releases?: readonly MossRelease[];
  readonly className?: string;
}) {
  const { locale } = useTranslation();
  const zh = locale === "zh-CN";
  const shown = mossReleasesUpTo(runningVersion, releases);
  return (
    <ul className={cn("flex flex-col", className)} data-testid="moss-release-history">
      {shown.map((release, index) => (
        <MossReleaseRow
          key={release.version}
          release={release}
          zh={zh}
          defaultOpen={index === 0}
          isLast={index === shown.length - 1}
        />
      ))}
    </ul>
  );
}

function MossReleaseRow({
  release,
  zh,
  defaultOpen,
  isLast,
}: {
  readonly release: MossRelease;
  readonly zh: boolean;
  readonly defaultOpen: boolean;
  readonly isLast: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const notes = zh ? release.notes.zh : release.notes.en;
  return (
    <li
      className={cn(!isLast && "border-b border-[color:var(--color-border)]")}
      data-moss-release={release.version}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full cursor-interaction items-center gap-2 py-2 text-left">
          <DisclosureChevron open={open} />
          <span className="text-ui text-foreground tabular-nums">{release.version}</span>
          <span className="text-ui text-muted-foreground">
            {zh ? release.date.zh : release.date.en}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ul className="m-0 list-disc space-y-1 pb-2.5 pl-10 text-ui text-muted-foreground">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}
