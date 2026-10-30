// FILE: InlineVisual.tsx
// Purpose: One agent-published inline visual, drawn the way it was published: a component
//          spec with the app's own components, or an HTML document in a sandboxed frame.
// Layer: Chat transcript row content
// Exports: InlineVisual

import type { InlineVisualActivityPayload, ThreadId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import { inlineVisualQueryOptions } from "~/lib/providerReactQuery";
import type { OpenUIDirective } from "~/lib/inlineVisualizationDirective";

import { InlineVisualBlocks, type InlineVisualBlocksActions } from "./InlineVisualBlocks";
import { InlineVisualFrame } from "./InlineVisualFrame";
import { OpenUIFrame } from "./OpenUIFrame";

function StoredOpenUIVisual({
  threadId,
  visual,
}: {
  readonly threadId: ThreadId;
  readonly visual: InlineVisualActivityPayload;
}) {
  const source = useQuery(inlineVisualQueryOptions({ threadId, visualId: visual.visualId }));
  if (source.isPending || typeof source.data !== "string") {
    return (
      <div className="my-2 h-24 animate-pulse rounded-md bg-muted/30" data-openui-state="loading" />
    );
  }
  const directive: OpenUIDirective = {
    code: source.data,
    source: source.data,
    partial: false,
  };
  return <OpenUIFrame threadId={threadId} directive={directive} isStreaming={false} />;
}

export function InlineVisual({
  threadId,
  visual,
  actions,
  onScrollIntent,
}: {
  readonly threadId: ThreadId;
  readonly visual: InlineVisualActivityPayload;
  readonly actions: InlineVisualBlocksActions;
  readonly onScrollIntent?: ((upward: boolean) => void) | undefined;
}) {
  return visual.format === "openui" ? (
    <StoredOpenUIVisual threadId={threadId} visual={visual} />
  ) : visual.format === "components" ? (
    <InlineVisualBlocks threadId={threadId} visual={visual} actions={actions} />
  ) : (
    <InlineVisualFrame threadId={threadId} visual={visual} onScrollIntent={onScrollIntent} />
  );
}
