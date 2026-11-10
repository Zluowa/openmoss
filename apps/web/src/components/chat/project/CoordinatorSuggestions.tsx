import type { GroupSettingsSection } from "../group/groupSettingsDialog.logic";
import { cn } from "~/lib/utils";
import {
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
} from "../composerPickerStyles";
import {
  type CoordinatorSuggestionChip,
  coordinatorSuggestionSection,
} from "./coordinatorSuggestions.logic";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { XIcon } from "~/lib/icons";
import { useMossbotCopy } from "~/components/mossbot/mossbot.copy";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";

export function CoordinatorSuggestions({
  chips,
  composerHeightPx,
  onOpenSettings,
  personal = false,
  onPrompt,
}: {
  chips: readonly CoordinatorSuggestionChip[];
  composerHeightPx: number;
  onOpenSettings: (section: GroupSettingsSection) => void;
  personal?: boolean;
  onPrompt?: (text: string) => void;
}) {
  const { t } = useMossbotCopy();
  const [dismissed, setDismissed] = useState(false);
  return (
    <div
      className={cn("shrink-0 pb-28", CHAT_COLUMN_GUTTER_CLASS_NAME)}
      // Keep the original minimum gap, and clear the floating composer when attachments
      // or wrapped text make it taller. Its existing observer tracks both growth and shrinkage.
      style={{ paddingBottom: `max(7rem, ${composerHeightPx + 8}px)` }}
    >
      <div className={cn(CHAT_COLUMN_FRAME_CLASS_NAME, "flex flex-col gap-2 px-1")}>
        {personal ? (
          <DisclosureRegion open={!dismissed}>
            <div className="mossbot-onboarding">
              <div className="mb-2 flex items-center gap-3">
                <h2 className="flex-1 text-ui-lg font-medium">
                  {t("What would you like help with?")}
                </h2>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("Dismiss suggestions")}
                  onClick={() => setDismissed(true)}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
              {[
                "Email and calendar",
                "Research and writing",
                "Shopping and reservations",
                "Code and projects",
                "Just chat",
              ].map((label, index) => (
                <button
                  type="button"
                  key={label}
                  className="mossbot-onboarding-option"
                  onClick={() => onPrompt?.(t(label))}
                >
                  <span className="mossbot-option-letter">{String.fromCharCode(65 + index)}</span>
                  <span>{t(label)}</span>
                </button>
              ))}
            </div>
            <p className="px-4 text-ui-sm text-muted-foreground">
              {t("Or answer in the conversation below")}
            </p>
          </DisclosureRegion>
        ) : (
          <>
            <div className="text-ui text-muted-foreground">Suggestions</div>
            <div className="flex flex-wrap gap-2">
              {chips.map((label) => (
                <Button
                  variant="outline"
                  size="sm"
                  shape="capsule"
                  key={label}
                  type="button"
                  onClick={() => onOpenSettings(coordinatorSuggestionSection(label))}
                >
                  {label}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
