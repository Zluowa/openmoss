import { lazy, Suspense, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { resolveNewConversationDefaultModelSelection, useAppSettings } from "~/appSettings";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

const MossbotCreateDialog = lazy(() =>
  import("./MossbotCreateDialog").then((module) => ({ default: module.MossbotCreateDialog })),
);

/** Both the sidebar and the landing use the same creation flow and native thread route. */
export function MossbotCreateLauncher(props: {
  template: string | null;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const root = useWorkspacePathsStore((state) => state.groupsWorkspaceRoot);
  const model = useMemo(() => resolveNewConversationDefaultModelSelection(settings), [settings]);
  return props.template ? (
    <Suspense fallback={null}>
      <MossbotCreateDialog
        key={props.template}
        open
        templateId={props.template}
        defaultModelSelection={model}
        workspacePath={root ?? ""}
        onClose={props.onClose}
        onCreated={(overview) => {
          props.onClose();
          props.onCreated?.();
          if (overview.config?.coordinatorThreadId)
            void navigate({
              to: "/$threadId",
              params: { threadId: overview.config?.coordinatorThreadId },
            });
        }}
      />
    </Suspense>
  ) : null;
}
