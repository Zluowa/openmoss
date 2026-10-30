// FILE: ComputerHistoryIcon.tsx
// Purpose: Moss-owned Computer History mark shared by React message chips and
//          the imperative Lexical composer mention renderer.
// Layer: UI shared component/helper
// Exports: ComputerHistoryIcon, createComputerHistoryIconElement

import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

const COMPUTER_HISTORY_ICON_SHELL_CLASS_NAME = [
  "relative inline-block overflow-hidden rounded-[3px]",
  "bg-[radial-gradient(circle_at_48%_42%,#5dddd8_0%,#168486_44%,#075255_72%,#04383b_100%)]",
].join(" ");

const COMPUTER_HISTORY_ICON_MARK_CLASS_NAME =
  "absolute inset-[2px] size-[calc(100%_-_4px)] object-contain brightness-0 invert";

export function ComputerHistoryIcon({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      aria-hidden="true"
      data-computer-history-icon="true"
      className={cn(COMPUTER_HISTORY_ICON_SHELL_CLASS_NAME, className, "size-4")}
    >
      <img
        src="/moss-logo-coral.png"
        alt=""
        draggable={false}
        className={COMPUTER_HISTORY_ICON_MARK_CLASS_NAME}
      />
    </span>
  );
}

export function createComputerHistoryIconElement(className: string): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.ariaHidden = "true";
  icon.dataset.computerHistoryIcon = "true";
  icon.className = cn(COMPUTER_HISTORY_ICON_SHELL_CLASS_NAME, className, "size-4");

  const mark = document.createElement("img");
  mark.src = "/moss-logo-coral.png";
  mark.alt = "";
  mark.draggable = false;
  mark.className = COMPUTER_HISTORY_ICON_MARK_CLASS_NAME;
  icon.append(mark);
  return icon;
}
