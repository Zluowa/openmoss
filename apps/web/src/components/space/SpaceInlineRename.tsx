// FILE: SpaceInlineRename.tsx
// Purpose: The field a 资料空间 name turns into on 重命名, in place: it takes focus with the name
//          selected, Enter or leaving it keeps the new name, Esc keeps the old one.
// Layer: Space UI, shared by the item card and the editors' title menus

import { useEffect, useRef, useState } from "react";

import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";

import { Input } from "../ui/input";

export function SpaceInlineRename(props: {
  readonly value: string;
  /** Called with the trimmed new name, only when it is not empty and differs. */
  readonly onCommit: (title: string) => void;
  /** Called when the field closes, kept or not. */
  readonly onDone: () => void;
  readonly label: string;
  /** Classes for the field's box (its width). */
  readonly className?: string;
}) {
  const [text, setText] = useState(props.value);
  const field = useRef<HTMLInputElement>(null);
  const closed = useRef(false);

  // A menu that closes hands focus back to its trigger first; take it after that.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      field.current?.focus({ preventScroll: true });
      field.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const finish = (keep: boolean) => {
    if (closed.current) return;
    closed.current = true;
    const next = text.trim().slice(0, 256);
    if (keep && next && next !== props.value) props.onCommit(next);
    props.onDone();
  };

  return (
    <Input
      ref={field}
      size="sm"
      nativeInput
      aria-label={props.label}
      data-space-inline-rename
      value={text}
      maxLength={256}
      className={props.className}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (isImeComposingKeyEvent(event)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
    />
  );
}
