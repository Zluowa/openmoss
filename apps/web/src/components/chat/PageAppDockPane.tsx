// FILE: PageAppDockPane.tsx
// Purpose: An 应用页 hosted inside the chat right dock beside the conversation, opened from its
//          chat card/link or automatically when the agent creates a new app in the thread.
// Layer: Chat right-dock pane
// Exports: PageAppDockPane, useAgentPageAppAutoOpen

import type { ThreadId } from "@moss/contracts";
import { pageAppFromActivity, type PageAppArtifact } from "@moss/shared/chatArtifactActivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { useResidentRuntime } from "~/lib/dockRuntimeResidency";
import { readNativeApi } from "~/nativeApi";
import type { RightDockPageAppReference } from "~/rightDockStore.logic";

import { AppPageFrame } from "../pageApps/AppPageFrame";
import { openPageAppInSidePanel } from "./ChatArtifactCards";

function useThreadPageAppEvents(threadId: string, listener: (app: PageAppArtifact) => void) {
  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    return api.orchestration.onDomainEvent((event) => {
      if (event.type !== "thread.activity-appended" || event.payload.threadId !== threadId) return;
      const app = pageAppFromActivity(event.payload.activity);
      if (app) listener(app);
    });
  }, [threadId, listener]);
}

export function PageAppDockPane(props: {
  threadId: ThreadId;
  pageApp: RightDockPageAppReference;
  residency?: { readonly key: string; readonly visible: boolean };
  onTitleChange?: (title: string) => void;
  onClose: () => void;
}) {
  const [epoch, setEpoch] = useState(0);
  const { appId } = props.pageApp;
  const appIdRef = useRef(appId);
  appIdRef.current = appId;

  const onPageAppEvent = useCallback(
    (app: PageAppArtifact) => {
      if (app.appId !== appIdRef.current) return;
      props.onTitleChange?.(app.title);
      if (app.change === "edited") {
        setEpoch((value) => value + 1);
      }
    },
    [props],
  );
  useThreadPageAppEvents(props.threadId, onPageAppEvent);

  const runtime = useResidentRuntime({
    active: props.residency !== undefined,
    key: props.residency?.key ?? "",
    owner: props.threadId,
    runtimeClass: "dockFrame",
    visible: props.residency?.visible ?? true,
    suspend: async () => true,
  });

  if (!runtime.loaded) {
    return (
      <div className="h-full w-full" data-page-app-dock-pane={appId} data-suspended aria-hidden />
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      data-page-app-dock-pane={appId}
    >
      <AppPageFrame
        key={`${appId}:${epoch}`}
        appPageId={appId}
        mode="full"
        topBar={false}
        onTitleChange={props.onTitleChange}
        onCloseTab={props.onClose}
        onDeleted={props.onClose}
      />
    </div>
  );
}

/**
 * Opens an 应用页 the agent has just created in this conversation's right dock, once:
 * only for live thread activity events, matching Claude's split-pane artifact UX.
 */
export function useAgentPageAppAutoOpen(threadId: ThreadId) {
  const opened = useRef(new Set<string>());
  const onPageAppEvent = useCallback(
    (app: PageAppArtifact) => {
      if (app.change !== "created" || opened.current.has(app.appId)) return;
      opened.current.add(app.appId);
      openPageAppInSidePanel(threadId, { appId: app.appId, title: app.title });
    },
    [threadId],
  );
  useThreadPageAppEvents(threadId, onPageAppEvent);
}
