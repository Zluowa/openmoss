// FILE: AppPageGuestPlaceholder.tsx
// Purpose: Stands in for `AppPageFrame` (mode "guest") until the 应用页 runtime lands.
// Layer: Guest page (page links and sites)
// Why: The interface contract names `AppPageFrame` with `{ appPageId, mode, height }`. The
//      guest page renders this card with the same props, so swapping in the real frame is one
//      import. The real frame also needs the 应用页 files served over the relay (follow-up).

import type { PageGuestCopy } from "./pageGuestCopy";

export function AppPageGuestPlaceholder(props: {
  readonly appPageId: string;
  readonly mode: "full" | "embed" | "guest";
  readonly height?: number;
  readonly copy: PageGuestCopy;
}) {
  return (
    <div
      data-app-page-id={props.appPageId}
      data-mode={props.mode}
      className="flex flex-col items-center justify-center gap-1 rounded-card border border-dashed border-border px-4 text-center"
      style={{ minHeight: props.height ?? 240 }}
    >
      <p className="text-ui font-medium text-foreground">{props.copy.appPlaceholder}</p>
      <p className="text-ui-sm text-muted-foreground">{props.copy.appPlaceholderDetail}</p>
    </div>
  );
}
