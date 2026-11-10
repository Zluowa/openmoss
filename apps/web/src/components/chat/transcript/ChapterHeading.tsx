// FILE: ChapterHeading.tsx
// Purpose: The desktop chat's chapter heading: pinning a reply "as chapter" puts a
//          semibold heading above it (at most two lines, a jump target). Double-click
//          renames it in place: Enter saves, Escape or a blur without change cancels.
// Layer: Chat transcript primitive
// Exports: ChapterHeading, chapterAnchorId

import { useEffect, useRef, useState } from "react";

import { useTranslation } from "~/localization";

export function chapterAnchorId(messageId: string): string {
  return `chapter-${messageId}`;
}

export function ChapterHeading(props: {
  messageId: string;
  title: string;
  onRename?: ((title: string | null) => void) | undefined;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    doneRef.current = false;
    inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const next = inputRef.current?.value.trim() ?? "";
    if (next !== props.title) props.onRename?.(next === "" ? null : next);
    setEditing(false);
  };

  if (editing) {
    return (
      <h3
        id={chapterAnchorId(props.messageId)}
        data-chapter-heading="editing"
        className="scroll-mt-14 text-size-chat font-semibold text-foreground"
      >
        <input
          ref={inputRef}
          defaultValue={props.title}
          aria-label={t("transcript.chapter.title")}
          size={Math.min(Math.max(props.title.length, 10), 40)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              doneRef.current = true;
              setEditing(false);
            }
          }}
          className="min-w-0 max-w-full rounded-[3px] border-0 bg-transparent p-0 font-semibold outline outline-[1.5px] outline-offset-1 outline-[var(--color-text-accent)] [field-sizing:content]"
        />
      </h3>
    );
  }
  return (
    <h3
      id={chapterAnchorId(props.messageId)}
      data-chapter-heading=""
      title={props.title}
      onDoubleClick={props.onRename ? () => setEditing(true) : undefined}
      className="line-clamp-2 scroll-mt-14 text-size-chat font-semibold text-foreground select-text"
    >
      {props.title}
    </h3>
  );
}
