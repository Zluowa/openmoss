// FILE: awaitingApproval.ts
// Purpose: Tell whether a widget's own tool call is still waiting for the person's approval, so
//          the widget (and its device prompt) only mounts once the call is allowed to run.
// Layer: Web MCP App host state
// Exports: useMcpAppCallAwaitingApproval, isMcpAppApprovalForBinding

import type { ThreadId } from "@moss/contracts";
import { useCallback } from "react";

import { derivePendingApprovals, type PendingApproval } from "../../pendingInteractionDerivation";
import { useStore } from "../../store";
import { createThreadSelector } from "../../storeSelectors";
import type { McpAppBinding } from "./contracts";

/** An approval names a tool as `tool`, `server/tool`, `mcp__server__tool` or `server__tool`. */
export function isMcpAppApprovalForBinding(
  approval: Pick<PendingApproval, "toolName" | "toolServerName">,
  binding: Pick<McpAppBinding, "server" | "toolName">,
): boolean {
  const name = approval.toolName;
  if (!name) return false;
  if (approval.toolServerName && approval.toolServerName !== binding.server) return false;
  return (
    name === binding.toolName ||
    name === `${binding.server}/${binding.toolName}` ||
    name === `mcp__${binding.server}__${binding.toolName}` ||
    name.endsWith(`__${binding.toolName}`)
  );
}

export function useMcpAppCallAwaitingApproval(
  threadId: string,
  binding: Pick<McpAppBinding, "server" | "toolName">,
  callRunning: boolean,
): boolean {
  const selector = useCallback(
    (state: Parameters<ReturnType<typeof createThreadSelector>>[0]) => {
      if (!callRunning) return false;
      const thread = createThreadSelector(threadId as ThreadId)(state);
      if (!thread) return false;
      return derivePendingApprovals(thread.activities, thread.pendingInteractions, {
        authoritativeHasPending: thread.hasPendingApprovals,
        latestTurnId: thread.latestTurn?.turnId,
      }).some((approval) => isMcpAppApprovalForBinding(approval, binding));
    },
    [binding, callRunning, threadId],
  );
  return useStore(selector);
}
