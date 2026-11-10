// FILE: RunningChatsQuitCoordinator.tsx
// Purpose: Answers Electron quit requests: an idle app quits straight away; otherwise it
//          shows what is still running (chats, terminal commands, dev servers, imports, an
//          app update download) and asks.
// Layer: Root web coordinator
// Depends on: Desktop bridge quit IPC, the orchestration, terminal, dev-server and import
//             stores, and the quit-resume RPC.

import { ThreadId } from "@moss/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import {
  listRunningChatsFromDesktopStore,
  listRunningWorkForQuit,
  quitResumeContinuationPrompt,
  stopRunningChatsForQuit,
  type RunningChatQuitSummary,
  type RunningWorkQuitItem,
} from "~/lib/runningChatsQuitConfirmation";
import { listRunningImports, useRunningImportsStore } from "~/lib/runningImportsStore";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useProjectRunStore } from "~/projectRunStore";
import { useStore } from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";

import { RunningChatsQuitDialog, type RunningChatsQuitDecision } from "./RunningChatsQuitDialog";

export function RunningChatsQuitCoordinator() {
  const [prompt, setPrompt] = useState<{
    readonly chats: ReadonlyArray<RunningChatQuitSummary>;
    readonly work: ReadonlyArray<RunningWorkQuitItem>;
  } | null>(null);
  const chats = prompt?.chats ?? null;
  // True while the resume record is being written: the dialog stays up (inert) so the
  // user does not see a bare window for the bounded wait before the desktop hides it.
  const [quitting, setQuitting] = useState(false);
  const pendingRequestIdRef = useRef<string | null>(null);

  const settle = useCallback(
    (decision: RunningChatsQuitDecision | null) => {
      const requestId = pendingRequestIdRef.current;
      if (!requestId) {
        return;
      }
      const allow = decision != null;
      const chatsToStop = allow ? chats : null;
      pendingRequestIdRef.current = null;
      if (!decision?.resume) {
        setPrompt(null);
      }

      const reply = (allowQuit: boolean) => {
        window.desktopBridge?.replyQuitConfirmation({
          requestId,
          phase: "decision",
          allow: allowQuit,
        });
      };

      if (!allow || chatsToStop == null || chatsToStop.length === 0) {
        reply(allow);
        return;
      }

      const stopped = stopRunningChatsForQuit({
        chats: chatsToStop,
        dispatchInterrupt: (threadId) => {
          const api = readNativeApi();
          if (!api) {
            return;
          }
          return api.orchestration.dispatchCommand({
            type: "thread.turn.interrupt",
            commandId: newCommandId(),
            threadId: ThreadId.makeUnsafe(threadId),
            createdAt: new Date().toISOString(),
          });
        },
        ...(decision.resume
          ? {
              resume: {
                prepare: (threadIds: ReadonlyArray<string>) => {
                  const api = readNativeApi();
                  if (!api) {
                    return Promise.reject(new Error("Native API unavailable"));
                  }
                  return api.orchestration.prepareQuitResume({
                    threadIds: threadIds.map((threadId) => ThreadId.makeUnsafe(threadId)),
                    continuationPrompt: quitResumeContinuationPrompt(APP_DISPLAY_NAME),
                  });
                },
              },
            }
          : {}),
      });

      if (decision.resume) {
        // The resume record must be durable before the desktop is allowed to stop the
        // backend; the wait is bounded so quit stays snappy even if the server is slow.
        setQuitting(true);
        void stopped.finally(() => {
          reply(true);
          setQuitting(false);
          setPrompt(null);
        });
        return;
      }
      // Interrupt in the background so the window can close immediately.
      void stopped;
      reply(true);
    },
    [chats],
  );

  useEffect(() => {
    const subscribe = window.desktopBridge?.onQuitConfirmationRequest;
    const reply = window.desktopBridge?.replyQuitConfirmation;
    if (typeof subscribe !== "function" || typeof reply !== "function") {
      return;
    }

    return subscribe((request) => {
      const state = useStore.getState();
      const running = listRunningChatsFromDesktopStore(state);
      const work = listRunningWorkForQuit({
        terminalStateByThreadId: useTerminalStateStore.getState().terminalStateByThreadId,
        threadTitleById: (threadId) =>
          state.sidebarThreadSummaryById[threadId as ThreadId]?.title ??
          state.threadShellById?.[threadId as ThreadId]?.title,
        devServers: Object.values(useProjectRunStore.getState().runsByProjectId),
        projectNameById: (projectId) =>
          state.projects.find((project) => project.id === projectId)?.name,
        imports: listRunningImports(useRunningImportsStore.getState().importsById),
        updateDownloading: request.updateDownloading === true,
      });
      const runningCount = running.length + work.length;
      reply({
        requestId: request.requestId,
        phase: "ready",
        runningCount,
        chats: running,
      });
      // Nothing is running: the desktop quits straight away, so show nothing.
      if (runningCount === 0) return;
      pendingRequestIdRef.current = request.requestId;
      setPrompt({ chats: running, work });
    });
  }, []);

  return (
    <RunningChatsQuitDialog
      chats={prompt?.chats ?? null}
      work={prompt?.work ?? []}
      quitting={quitting}
      onStay={() => settle(null)}
      onQuit={settle}
    />
  );
}
