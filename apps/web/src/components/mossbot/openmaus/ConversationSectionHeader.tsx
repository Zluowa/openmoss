// Adapted from OpenMaus SidebarSectionHeader.tsx @ 58378e8 (Apache-2.0).
// Keeps the Simple section label, disclosure, count and menu composition.
// Moss owns focus, typography and disclosure motion. See third_party/openmaus/UI-PORTS.md.
import type { ReactNode } from "react";
import { CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";

export function ConversationSectionHeader({
  name,
  open,
  count,
  menu,
  onMove,
}: {
  name: string;
  open: boolean;
  count: number;
  menu?: ReactNode;
  onMove?: ((direction: -1 | 1) => void) | undefined;
}) {
  return (
    <div className="mossbot-conversation-section-header" data-section={name}>
      <CollapsibleTrigger
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-ui-sm text-muted-foreground"
        aria-label={name}
        aria-keyshortcuts={onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        onKeyDown={(event) => {
          if (onMove && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            onMove(event.key === "ArrowUp" ? -1 : 1);
          }
        }}
      >
        <span className="truncate">{name}</span>
        <DisclosureChevron open={open} className="size-3.5" />
        <span className="sr-only">{count}</span>
      </CollapsibleTrigger>
      {menu}
    </div>
  );
}
