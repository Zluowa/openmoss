// FILE: AssistantSelectionsSummaryChip.tsx
// Purpose: Renders the compact assistant-selection count chip used in composer and user bubbles.
// Layer: Chat attachment presentation

import { MessageCircleIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { AttachmentSummaryChip } from "./AttachmentSummaryChip";

interface AssistantSelectionsSummaryChipProps {
  selections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  onRemove?: (() => void) | undefined;
}

export function AssistantSelectionsSummaryChip(props: AssistantSelectionsSummaryChipProps) {
  const { t, format } = useTranslation();
  const count = props.selections.length;
  if (count === 0) {
    return null;
  }

  return (
    <AttachmentSummaryChip
      icon={MessageCircleIcon}
      label={
        count === 1 ? t("attachments.quotes.one") : format("attachments.quotes.many", { count })
      }
      removeLabel={t("attachments.quotes.remove")}
      onRemove={props.onRemove}
      tooltip={props.selections.map((selection) => (
        <p key={selection.id} className="text-ui leading-relaxed">
          {selection.text}
        </p>
      ))}
    />
  );
}
