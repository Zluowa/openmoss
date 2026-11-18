// FILE: ApprovalAppDock.tsx
// Purpose: The leading mark of a command approval card: one Moss tile that says what the card
//          asks for, running a command in a terminal, drawn here as SVG in Moss's own tokens.
//          It sits opposite Deny / Allow once.
// Layer: Chat composer UI

export function ApprovalAppDock() {
  return (
    <div className="flex min-w-0 items-center" data-approval-app-dock="true">
      <span
        className="approval-command-mark inline-flex size-8 shrink-0 items-center justify-center rounded-control border border-border"
        data-approval-command-mark=""
        aria-hidden
      >
        <svg viewBox="0 0 20 20" className="size-5" focusable="false">
          <rect
            className="approval-command-mark-window"
            x="2"
            y="3.5"
            width="16"
            height="13"
            rx="3"
          />
          <path className="approval-command-mark-ink" d="M6 8.25L8.5 10.5L6 12.75" />
          <path className="approval-command-mark-ink" d="M10.5 12.75H14" />
        </svg>
      </span>
    </div>
  );
}
