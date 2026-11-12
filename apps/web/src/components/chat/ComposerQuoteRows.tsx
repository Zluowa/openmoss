// FILE: ComposerQuoteRows.tsx
// Purpose: The composer's quoted passages, one row each (desktop chat): a reply arrow, the
//          passage on one line in quotation marks, "With reply" when the reader added their
//          own words to it, and a remove button.
// Layer: Chat composer presentation

import { QuoteReplyIcon, XIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerQuoteRowsProps {
  selections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  onRemove?: ((selectionId: string) => void) | undefined;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function ComposerQuoteRows(props: ComposerQuoteRowsProps) {
  const { t } = useTranslation();
  if (props.selections.length === 0) return null;
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 ps-0.5" data-composer-quote-rows="true">
      {props.selections.map((selection) => {
        const comment = selection.comment?.trim() ?? "";
        return (
          <div
            key={selection.id}
            data-composer-quote-row="true"
            className="flex min-w-0 items-center gap-1 rounded-composer-inset bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] p-1 ps-2"
          >
            <span className="flex h-7 shrink-0 items-center text-[var(--color-text-foreground-tertiary)]">
              <QuoteReplyIcon className="size-3.5" />
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <blockquote className="flex min-w-0 flex-1 text-ui font-normal text-[var(--color-text-foreground-secondary)]">
                    <span aria-hidden="true" className="shrink-0">
                      “
                    </span>
                    <span dir="auto" className="min-w-0 truncate">
                      {oneLine(selection.text)}
                    </span>
                    <span aria-hidden="true" className="shrink-0">
                      ”
                    </span>
                  </blockquote>
                }
              />
              <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
                {selection.text}
              </TooltipPopup>
            </Tooltip>
            {comment ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex h-5 max-w-[40%] shrink-0 items-center rounded-full border border-[color:var(--color-border)] px-1.5 text-ui-xs text-[var(--color-text-foreground-secondary)]">
                      <span className="truncate">{t("attachments.quotes.withReply")}</span>
                    </span>
                  }
                />
                <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
                  {comment}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            {props.onRemove ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("attachments.quotes.removeOne")}
                className="shrink-0 text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)]"
                onClick={() => props.onRemove?.(selection.id)}
              >
                <XIcon className="size-4" />
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
