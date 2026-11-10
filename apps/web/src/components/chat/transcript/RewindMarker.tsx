// FILE: RewindMarker.tsx
// Purpose: The desktop chat's "Rewound here" line under the last message a rewind
//          kept: a quiet centered label between hairlines, shown until the next send.
// Layer: Chat transcript primitive
// Exports: RewindMarker

import { Undo2Icon } from "~/lib/icons";
import { useTranslation } from "~/localization";

export function RewindMarker() {
  const { t } = useTranslation();
  return (
    <div
      data-rewind-marker=""
      role="note"
      className="flex items-center gap-2 pt-3 text-ui-sm text-muted-foreground"
    >
      <div aria-hidden className="h-px flex-1 bg-border" />
      <span className="inline-flex shrink-0 items-center gap-1.5">
        <Undo2Icon aria-hidden className="size-3.5" />
        {t("transcript.rewind.marker")}
      </span>
      <div aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
