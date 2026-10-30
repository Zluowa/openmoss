import { useCallback } from "react";

import { ensureHomeChatProject } from "../lib/chatProjects";
import { startContainerChat, type StartContainerChatResult } from "../lib/startContainerChat";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { useHandleNewThread, type NewThreadNavigationOptions } from "./useHandleNewThread";

export interface NewChatOptions {
  fresh?: boolean;
  navigation?: NewThreadNavigationOptions;
}

export function useHandleNewChat() {
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const { handleNewThread } = useHandleNewThread();

  const handleNewChat = useCallback(
    async (options?: NewChatOptions): Promise<StartContainerChatResult> => {
      if (!homeDir) {
        return {
          ok: false,
          error: "Home folder is not available yet.",
        };
      }

      return startContainerChat({
        ensureProjectId: () => ensureHomeChatProject({ homeDir, chatWorkspaceRoot }),
        handleNewThread,
        fresh: options?.fresh,
        navigation: options?.navigation,
        errorLabel: "Unable to prepare a new chat.",
      });
    },
    [chatWorkspaceRoot, handleNewThread, homeDir],
  );

  return { handleNewChat };
}
