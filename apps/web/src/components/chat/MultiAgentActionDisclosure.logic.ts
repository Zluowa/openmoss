// FILE: MultiAgentActionDisclosure.logic.ts
// Purpose: Map normalized multi-agent actions to the exact Codex timeline copy keys.

import type { TranslationKey } from "~/localization";
import type {
  MultiAgentAction,
  MultiAgentActionStatus,
  MultiAgentAgentState,
} from "../../lib/multiAgentAction";

type TimelineMultiAgentAction = Exclude<MultiAgentAction, "waitAgent">;

const INTERRUPTED_KEY =
  "localConversation.multiAgentAction.action.interrupted" satisfies TranslationKey;

const HEADER_KEYS: Record<
  TimelineMultiAgentAction,
  Record<Exclude<MultiAgentActionStatus, "interrupted">, TranslationKey>
> = {
  spawnAgent: {
    inProgress: "localConversation.multiAgentAction.header.spawn.inProgress",
    completed: "localConversation.multiAgentAction.header.spawn.completed",
    failed: "localConversation.multiAgentAction.header.spawn.failed",
  },
  sendInput: {
    inProgress: "localConversation.multiAgentAction.header.sendInput.inProgress",
    completed: "localConversation.multiAgentAction.header.sendInput.completed",
    failed: "localConversation.multiAgentAction.header.sendInput.failed",
  },
  sendMessage: {
    inProgress: "localConversation.multiAgentAction.header.sendInput.inProgress",
    completed: "localConversation.multiAgentAction.header.sendInput.completed",
    failed: "localConversation.multiAgentAction.header.sendInput.failed",
  },
  followupTask: {
    inProgress: "localConversation.multiAgentAction.header.sendInput.inProgress",
    completed: "localConversation.multiAgentAction.header.sendInput.completed",
    failed: "localConversation.multiAgentAction.header.sendInput.failed",
  },
  resumeAgent: {
    inProgress: "localConversation.multiAgentAction.header.resume.inProgress",
    completed: "localConversation.multiAgentAction.header.resume.completed",
    failed: "localConversation.multiAgentAction.header.resume.failed",
  },
  closeAgent: {
    inProgress: "localConversation.multiAgentAction.header.close.inProgress",
    completed: "localConversation.multiAgentAction.header.close.completed",
    failed: "localConversation.multiAgentAction.header.close.failed",
  },
  interruptAgent: {
    inProgress: "localConversation.multiAgentAction.interrupt.inProgress",
    completed: "localConversation.multiAgentAction.interrupt.completed",
    failed: "localConversation.multiAgentAction.interrupt.failed",
  },
  listAgents: {
    inProgress: "localConversation.multiAgentAction.list.inProgress",
    completed: "localConversation.multiAgentAction.list.completed",
    failed: "localConversation.multiAgentAction.list.failed",
  },
};

const ROW_KEYS: Record<
  TimelineMultiAgentAction,
  Record<Exclude<MultiAgentActionStatus, "interrupted">, TranslationKey>
> = {
  spawnAgent: {
    inProgress: "localConversation.multiAgentAction.rowAction.spawn.inProgress",
    completed: "localConversation.multiAgentAction.rowAction.spawn.completed",
    failed: "localConversation.multiAgentAction.rowAction.spawn.failed",
  },
  sendInput: {
    inProgress: "localConversation.multiAgentAction.rowAction.sendInput.inProgress",
    completed: "localConversation.multiAgentAction.rowAction.sendInput.completed",
    failed: "localConversation.multiAgentAction.rowAction.sendInput.failed",
  },
  sendMessage: {
    inProgress: "localConversation.multiAgentAction.rowAction.sendInput.inProgress",
    completed: "localConversation.multiAgentAction.rowAction.sendInput.completed",
    failed: "localConversation.multiAgentAction.rowAction.sendInput.failed",
  },
  followupTask: {
    inProgress: "localConversation.multiAgentAction.rowAction.sendInput.inProgress",
    completed: "localConversation.multiAgentAction.rowAction.sendInput.completed",
    failed: "localConversation.multiAgentAction.rowAction.sendInput.failed",
  },
  resumeAgent: {
    inProgress: "localConversation.multiAgentAction.rowAction.resume.inProgress",
    completed: "localConversation.multiAgentAction.rowAction.resume.completed",
    failed: "localConversation.multiAgentAction.rowAction.resume.failed",
  },
  closeAgent: {
    inProgress: "localConversation.multiAgentAction.rowAction.close.inProgress",
    completed: "localConversation.multiAgentAction.rowAction.close.completed",
    failed: "localConversation.multiAgentAction.rowAction.close.failed",
  },
  interruptAgent: {
    inProgress: "localConversation.multiAgentAction.interrupt.inProgress",
    completed: "localConversation.multiAgentAction.interrupt.completed",
    failed: "localConversation.multiAgentAction.interrupt.failed",
  },
  listAgents: {
    inProgress: "localConversation.multiAgentAction.list.inProgress",
    completed: "localConversation.multiAgentAction.list.completed",
    failed: "localConversation.multiAgentAction.list.failed",
  },
};

const SEND_PROMPT_ROW_KEYS: Record<
  Exclude<MultiAgentActionStatus, "interrupted">,
  TranslationKey
> = {
  inProgress: "localConversation.multiAgentAction.rowAction.sendInput.messaged.inProgress",
  completed: "localConversation.multiAgentAction.rowAction.sendInput.messaged.completed",
  failed: "localConversation.multiAgentAction.rowAction.sendInput.messaged.failed",
};

const AGENT_STATE_KEYS: Record<MultiAgentAgentState, TranslationKey> = {
  pendingInit: "localConversation.multiAgentAction.agentState.pendingInit",
  running: "localConversation.multiAgentAction.agentState.running",
  interrupted: "localConversation.multiAgentAction.agentState.interrupted",
  shutdown: "localConversation.multiAgentAction.agentState.shutdown",
  completed: "localConversation.multiAgentAction.agentState.completed",
  errored: "localConversation.multiAgentAction.agentState.errored",
  notFound: "localConversation.multiAgentAction.agentState.notFound",
};

export function multiAgentHeaderVerbKey(
  action: TimelineMultiAgentAction,
  status: MultiAgentActionStatus,
): TranslationKey {
  return status === "interrupted" ? INTERRUPTED_KEY : HEADER_KEYS[action][status];
}

export function multiAgentRowVerbKey(
  action: TimelineMultiAgentAction,
  status: MultiAgentActionStatus,
): TranslationKey {
  return status === "interrupted" ? INTERRUPTED_KEY : ROW_KEYS[action][status];
}

export function multiAgentSendPromptVerbKey(status: MultiAgentActionStatus): TranslationKey {
  return status === "interrupted" ? INTERRUPTED_KEY : SEND_PROMPT_ROW_KEYS[status];
}

export function multiAgentAgentStateKey(state: MultiAgentAgentState): TranslationKey {
  return AGENT_STATE_KEYS[state];
}

export function multiAgentCountLabelKey(count: number): TranslationKey {
  return count === 1
    ? "localConversation.multiAgentAction.header.count.one"
    : "localConversation.multiAgentAction.header.count.many";
}
