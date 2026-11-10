// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomBot } from "./host";
import { MentionTextarea } from "./MentionTextarea";
import { MentionMenu, type MentionChoice } from "./MentionMenu";
import { mentionQueryAt, mentionChoicesForQuery } from "./mentions";
import { mentionPicksFor } from "./mention-picks";
import { ComposerSendButton } from "./ComposerSendButton";
import { Square } from "./icons";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import {
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { cn } from "~/lib/utils";
import { composerFocusBehavior, MOBILE_CHAT_QUERY } from "../threebot/chatBehavior";
import { useMossbotCopy } from "../mossbot.copy";
import "./room.css";
export function Composer({
  draftId,
  text,
  editText,
  members,
  working,
  disabled,
  onSend,
  onStop,
}: {
  draftId: string;
  text: string;
  editText: (text: string) => void;
  members: RoomBot[];
  working: boolean;
  disabled: boolean;
  onSend: (picked: string[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const { t } = useMossbotCopy();
  const [caret, setCaret] = useState(0),
    [highlight, setHighlight] = useState(0),
    [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null),
    mentionListRef = useRef<HTMLDivElement>(null);
  const focus = useMemo(
    () => composerFocusBehavior(window.matchMedia(MOBILE_CHAT_QUERY).matches),
    [draftId],
  );
  useEffect(() => focus.onEntry(inputRef.current), [focus]);
  const picks = mentionPicksFor(draftId);
  const mention = mentionQueryAt(text, caret);
  const candidates =
    mention && mention.start !== dismissedAt
      ? mentionChoicesForQuery<MentionChoice>(
          [
            { id: "__everyone__", name: "everyone" },
            ...members.map((bot) => ({ id: bot.id, name: bot.name, bot })),
          ],
          mention.query,
        )
      : [];
  const mentionPickerOpen = candidates.length > 0;
  useEffect(() => setHighlight(0), [mention?.start, mention?.query]);
  useEffect(() => {
    if (mentionPickerOpen)
      mentionListRef.current
        ?.querySelector<HTMLElement>(`[data-mention-index="${highlight}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [highlight, mentionPickerOpen]);
  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    picks.pick(peer);
    editText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      if (inputRef.current) focus.onClick(inputRef.current);
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };
  const send = async () => {
    if (disabled || !text.trim()) return;
    if (await onSend(picks.ids(text))) picks.clear();
  };
  return (
    <div data-room-composer className="relative mx-auto w-full max-w-3xl px-4 pb-5">
      <div
        data-chat-composer-surface=""
        className={cn(
          COMPOSER_INPUT_SHELL_CLASS_NAME,
          COMPOSER_INPUT_SURFACE_CLASS_NAME,
          "mossbot-room-composer-surface relative p-2",
        )}
      >
        <div className="absolute bottom-full start-2 z-20 mb-2 w-72 max-w-[calc(100%-1rem)]">
          <DisclosureRegion open={mentionPickerOpen}>
            <MentionMenu
              listRef={mentionListRef}
              choices={candidates}
              highlight={highlight}
              everyoneCount={members.length}
              onPick={pickMention}
              onHighlight={setHighlight}
              className="static mb-0 w-full"
            />
          </DisclosureRegion>
        </div>
        <div className="flex items-end gap-1.5">
          <MentionTextarea
            inputRef={inputRef}
            peers={members}
            everyone
            dir="auto"
            rows={1}
            value={text}
            onChange={(e) => {
              editText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setDismissedAt(null);
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onPointerDown={(e) => focus.onPointerDown(e.currentTarget)}
            onPointerCancel={(e) => focus.onPointerCancel(e.currentTarget)}
            onFocus={(e) => focus.onFocus(e.currentTarget)}
            onBlur={(e) => focus.onBlur(e.currentTarget)}
            onClick={(e) => {
              focus.onClick(e.currentTarget);
              setCaret(e.currentTarget.selectionStart ?? 0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              if (mentionPickerOpen) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const choice = candidates[highlight];
                  if (choice) pickMention(choice);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissedAt(mention?.start ?? null);
                  return;
                }
              }

              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={mentionPickerOpen}
            aria-controls="room-mention-options"
            aria-activedescendant={
              mentionPickerOpen ? `composer-mention-${candidates[highlight]?.id}` : undefined
            }
            aria-label={t("Message group")}
            placeholder={t("Message group")}
            className="max-h-36 min-h-9 w-full resize-none border-0 bg-transparent font-[inherit] px-2 py-1.5 text-ui leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-50"
            disabled={disabled}
          />
          {working && (
            <button
              type="button"
              onClick={onStop}
              aria-label={t("Stop group")}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground hover:text-foreground"
            >
              <Square size={14} />
            </button>
          )}
          <ComposerSendButton
            compact={false}
            waits={working}
            label={t(working ? "Queue message" : "Send message")}
            title={t(working ? "Queue message" : "Send message")}
            disabled={disabled || !text.trim()}
            look={{
              className: "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30",
            }}
            onSend={() => void send()}
          />
        </div>
      </div>
    </div>
  );
}
