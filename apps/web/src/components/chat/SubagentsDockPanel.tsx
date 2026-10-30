// Shared dock opening and selection for the route shell and reusable chat surfaces.
import type { ThreadId } from "@synara/contracts";
import { useCallback, useMemo } from "react";
import { useRightDockStore } from "../../rightDockStore";
import type { RightDockPane, RightDockPaneKind } from "../../rightDockStore.logic";
import { useStore } from "../../store";
import { createThreadSelector } from "../../storeSelectors";
import { SubagentsDockPane } from "./SubagentsDockPane";

export interface SubagentPanelSelection {
  threadId: ThreadId;
  displayName?: string | null;
}

export function useOpenSubagentsPanel(
  hostThreadId: ThreadId,
  activate: (kind: RightDockPaneKind) => void,
) {
  const selectThread = useMemo(() => createThreadSelector(hostThreadId), [hostThreadId]);
  const parentThreadId = useStore((state) => selectThread(state)?.parentThreadId);
  const openPane = useRightDockStore((state) => state.openPane);
  return useCallback(
    (selection: SubagentPanelSelection | null) => {
      activate("subagents");
      openPane(hostThreadId, {
        kind: "subagents",
        subagentsSourceThreadId: parentThreadId ?? hostThreadId,
        subagentsSelectedThreadId: selection?.threadId ?? null,
        subagentsSelectedDisplayName: selection?.displayName ?? null,
      });
    },
    [activate, hostThreadId, openPane, parentThreadId],
  );
}

export function SubagentsDockPanel({
  hostThreadId,
  pane,
}: {
  hostThreadId: ThreadId;
  pane: RightDockPane;
}) {
  return <SubagentsDockPane hostThreadId={pane.subagentsSourceThreadId ?? hostThreadId} />;
}
