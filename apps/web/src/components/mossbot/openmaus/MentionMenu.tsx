// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import type { RefObject } from "react";
import { Users } from "./icons";
import { cn } from "~/lib/utils";
import { BotAvatar, type RoomBot } from "./host";
import { ComposerMenuRow } from "./ComposerMenuRow";
import { useMossbotCopy } from "../mossbot.copy";
export type MentionChoice = { id: string; name: string; bot?: RoomBot };
export function MentionMenu({
  listRef,
  choices,
  highlight,
  everyoneCount,
  onPick,
  onHighlight,
  className,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  choices: MentionChoice[];
  highlight: number;
  everyoneCount: number;
  onPick: (choice: MentionChoice) => void;
  onHighlight: (index: number) => void;
  className?: string;
}) {
  const { t } = useMossbotCopy();
  return (
    <div
      ref={listRef}
      id="room-mention-options"
      role="listbox"
      aria-label={t("Mention an assistant")}
      className={cn(
        "absolute bottom-full start-2 z-20 mb-2 max-h-72 w-72 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-border/40 bg-muted shadow-lg",
        className,
      )}
    >
      {choices.map((choice, i) => {
        const description =
          choice.bot?.title || (choice.bot ? "" : `${everyoneCount} ${t("Assistants")}`);
        return (
          <ComposerMenuRow
            key={choice.id}
            id={`composer-mention-${choice.id}`}
            data-mention-index={i}
            role="option"
            aria-selected={i === highlight}
            onClick={() => onPick(choice)}
            onMouseEnter={() => onHighlight(i)}
            selected={i === highlight}
            icon={
              choice.bot ? (
                <BotAvatar bot={choice.bot} size={24} />
              ) : (
                <span className="flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Users size={14} aria-hidden="true" />
                </span>
              )
            }
            name={choice.name}
            description={description || undefined}
            kind={choice.bot ? t("Assistant") : t("Group chat")}
          />
        );
      })}
    </div>
  );
}
