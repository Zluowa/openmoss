// FILE: SpaceInlineRename.tsx
// Purpose: The field a 资料空间 name turns into on 重命名, in place: it takes focus with the name
//          selected, Enter or leaving it keeps the new name, Esc keeps the old one.
// Layer: Space UI, shared by the item card and the editors' title menus

import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

export function SpaceInlineRename(props: {
  readonly value: string;
  /** Called with the trimmed new name, only when it is not empty and differs. */
  readonly onCommit: (title: string) => void;
  /** Called when the field closes, kept or not. */
  readonly onDone: () => void;
  readonly label: string;
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
    <input
      ref={field}
      aria-label={props.label}
      data-space-inline-rename
      value={text}
      maxLength={256}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      className={cn(
        "min-w-0 rounded-control-xs bg-background font-sans! text-foreground outline-none ring-2 ring-ring",
        props.className,
      )}
    />
  );
}
