// FILE: HoverMountGate.tsx
// Purpose: The desktop chat mounts a message's action bar only when the reader first
//          hovers or focuses that message; until then the row keeps a same-height
//          spacer and a screen-reader button ("Show message actions"). Long chats then
//          skip hundreds of hidden toolbars. Touch screens, which cannot hover, mount
//          at once, and a message once opened stays mounted when it scrolls back in.
// Layer: Chat transcript performance primitive
// Exports: HoverMountGate

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const openedIds = new Set<string>();

function hoverUnavailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none), (pointer: coarse)").matches
  );
}

export function HoverMountGate(props: {
  /** Stable id of the message; an opened message stays mounted. */
  id: string;
  /** False mounts the children right away (e.g. the latest reply's footer). */
  enabled: boolean;
  /** Classes giving the spacer the bar's exact height and margins. */
  placeholderClassName: string;
  /** Screen-reader label of the reveal button. */
  revealLabel: string;
  children: ReactNode;
}) {
  const { id, enabled } = props;
  const [mounted, setMounted] = useState(() => !enabled || openedIds.has(id) || hoverUnavailable());
  const ref = useRef<HTMLSpanElement | null>(null);
  const open = useCallback(() => {
    openedIds.add(id);
    setMounted(true);
  }, [id]);

  useEffect(() => {
    if (mounted) return;
    const host = ref.current?.closest<HTMLElement>(".group") ?? ref.current?.parentElement;
    if (!host) return;
    host.addEventListener("pointerenter", open);
    host.addEventListener("focusin", open);
    return () => {
      host.removeEventListener("pointerenter", open);
      host.removeEventListener("focusin", open);
    };
  }, [mounted, open]);

  if (mounted || !enabled) return <>{props.children}</>;
  return (
    <span ref={ref} data-message-actions-placeholder="" className={props.placeholderClassName}>
      <button type="button" className="sr-only" onFocus={open} onClick={open}>
        {props.revealLabel}
      </button>
    </span>
  );
}
