// FILE: ShownVisualToolResult.tsx
// Purpose: The opened body of a 「已生成图表」 tool row: the chart that `moss_show_visual`
//          published, or one quiet line naming it when this transcript cannot draw it.
//          Never the tool's JSON reply to the agent.
// Layer: Chat transcript row content
// Exports: ShownVisualToolResult

import { useContext } from "react";

import { useTranslation } from "~/localization";

import { InlineVisualByIdContext } from "./inlineVisualEmbedContext";
import type { ShownVisualToolResult as ShownVisual } from "./shownVisualToolResult.logic";

export function ShownVisualToolResult({ visual }: { readonly visual: ShownVisual }) {
  const { format, t } = useTranslation();
  const renderVisual = useContext(InlineVisualByIdContext);
  const chart = renderVisual?.(visual.visualId) ?? null;
  if (chart) {
    return (
      <div
        className="min-w-0"
        data-shown-visual-result="chart"
        data-testid="shown-visual-result"
        data-visual-id={visual.visualId}
      >
        {chart}
      </div>
    );
  }
  return (
    <p
      className="truncate text-ui-sm leading-5 text-muted-foreground"
      data-shown-visual-result="compact"
      data-testid="shown-visual-result"
      data-visual-id={visual.visualId}
    >
      {visual.title
        ? format("chat.shownVisual.readyTitled", { title: visual.title })
        : t("chat.shownVisual.ready")}
    </p>
  );
}
