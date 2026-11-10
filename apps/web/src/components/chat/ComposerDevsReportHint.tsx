// FILE: ComposerDevsReportHint.tsx
// Purpose: One quiet line above the composer while the draft starts with `@devs`: it says
//          what to write and that the report is shown for confirmation before it is sent.
// Layer: Chat composer UI
// Exports: ComposerDevsReportHint

import { BugReportIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";

export function ComposerDevsReportHint() {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-2 px-4 pt-3 pb-1 text-ui-sm text-muted-foreground"
      data-composer-devs-hint=""
    >
      <BugReportIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0">{t("devs.composerHint")}</span>
    </div>
  );
}
