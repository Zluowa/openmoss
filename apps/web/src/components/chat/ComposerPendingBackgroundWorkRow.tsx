// FILE: ComposerPendingBackgroundWorkRow.tsx
// Purpose: Compact "waiting on background agents" capsule above the composer after the
// latest turn has settled while background subagents keep running.
// Layer: Chat composer UI
// Exports: ComposerPendingBackgroundWorkRow

import { BotIcon } from "~/lib/icons";
import { useTranslation } from "../../localization";
import { ComposerCapsule } from "./ComposerCapsule";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";

interface ComposerPendingBackgroundWorkRowProps {
  count: number;
}

export function ComposerPendingBackgroundWorkRow({ count }: ComposerPendingBackgroundWorkRowProps) {
  const { format } = useTranslation();
  const summary = format(
    count === 1
      ? "composer.backgroundSubagents.summary.one"
      : "composer.backgroundSubagents.summary.many",
    { count },
  );
  const hint = format("composer.backgroundSubagents.invokeAgents", {});
  return (
    <ComposerCapsule
      icon={<BotIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
      testId="pending-background-work-row"
    >
      {summary} {hint}
    </ComposerCapsule>
  );
}
