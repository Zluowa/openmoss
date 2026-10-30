// FILE: SidebarSectionToolbar.tsx
// Purpose: Cluster of header actions beside a sidebar section or project title.
// Layer: Sidebar UI primitive
// Exports: SidebarSectionToolbar

import type { CSSProperties, ReactNode } from "react";
import { cn } from "~/lib/utils";

export function SidebarSectionToolbar({
  placement: placementProp,
  revealOnHover: revealOnHoverProp,
  forceVisible = false,
  className,
  children,
}: {
  /** `inline` = Threads section header; `overlay` = Chats/project collapsible headers. */
  placement?: "inline" | "overlay";
  /** Fade in on `group/project-header` hover/focus (project rows only). */
  revealOnHover?: boolean;
  /** Keep a focused/expanded menu trigger interactive even when no hover is present. */
  forceVisible?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const placement = placementProp ?? "inline";
  const revealOnHover = revealOnHoverProp ?? false;
  const revealClassName = revealOnHover
    ? forceVisible
      ? "pointer-events-auto opacity-100 transition-opacity"
      : "pointer-events-none opacity-100 transition-opacity md:opacity-0 md:group-hover/project-header:pointer-events-auto md:group-hover/project-header:opacity-100 md:project-header-focus:pointer-events-auto md:project-header-focus:opacity-100 md:has-[[data-state=open]]:pointer-events-auto md:has-[[data-state=open]]:opacity-100"
    : forceVisible
      ? "pointer-events-auto opacity-100"
      : null;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        placement === "inline" ? "-mr-1" : "absolute top-1 right-1.5",
        revealClassName,
        className,
      )}
      style={
        forceVisible ? ({ opacity: 1, pointerEvents: "auto" } satisfies CSSProperties) : undefined
      }
    >
      {children}
    </div>
  );
}
