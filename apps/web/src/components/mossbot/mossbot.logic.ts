import type {
  ModelSelection,
  MossbotRoomView,
  ProjectAgentConfigureInput,
  ProjectAgentSummary,
  ProjectId,
  ThreadId,
} from "@moss/contracts";
import {
  buildGroupConfigureInput,
  buildGroupSettingsBaseline,
} from "../chat/group/groupSettingsDialog.logic";
import type { TurnFileWindow } from "../../lib/threadOutputFileTimes";

/** New assistants start as the original pinwheel kid (风车娃) in its block form. */
export const MOSSBOT_DEFAULT_AVATAR_KEY = "mossbot-kid-block";

export const MOSSBOT_TEMPLATES = [
  {
    id: "personal",
    name: "Personal assistant",
    description: "Research, write, plan, and keep track of what matters.",
    instructions:
      "Help me with research, writing, planning, and everyday work. Be concise, practical, and clear about what you have verified. Remember useful preferences with their sources. Use the skills I enable and ask when you need a decision.",
  },
  {
    id: "research",
    name: "Research partner",
    description: "Follow questions through to evidence and useful conclusions.",
    instructions:
      "Be my research partner. Find primary sources, compare evidence, distinguish facts from assumptions, and give me useful conclusions with sources. Keep research notes and suggest follow-ups only when they help.",
  },
  {
    id: "projects",
    name: "Project partner",
    description: "Coordinate work across projects and bring back the results.",
    instructions:
      "Help me move my projects forward. Understand the goal, inspect current work, use scoped worker threads when useful, track decisions and blockers, and report verified results. Preserve existing work and respect approvals.",
  },
] as const;

export function isMossbot(
  summary: Pick<ProjectAgentSummary, "agentKind"> | null | undefined,
): boolean {
  return summary?.agentKind === "mossbot";
}

/** Workers keep their assistant's sidebar even when they execute in a linked project. */
export function resolveMossbotForThread(input: {
  projectId: ProjectId | null;
  threadId: ThreadId | null;
  summaries: ReadonlyMap<ProjectId, ProjectAgentSummary>;
}): ProjectAgentSummary | null {
  const direct = input.projectId ? input.summaries.get(input.projectId) : null;
  if (isMossbot(direct)) return direct ?? null;
  if (input.threadId === null) return null;
  for (const summary of input.summaries.values()) {
    if (
      isMossbot(summary) &&
      (summary.coordinatorThreadId === input.threadId ||
        summary.memberThreadIds?.includes(input.threadId))
    )
      return summary;
  }
  return null;
}

/** Keep the complete provider selection, including the user's account and native options. */
export function buildMossbotConfigureInput(input: {
  projectId: ProjectId;
  requestId: string;
  name: string;
  instructions: string;
  modelSelection: ModelSelection;
  userLocale?: "en" | "zh-CN";
  avatar?: string;
  /** Assistant colour key (coordinatorColor); the default face takes it as its tone. */
  color?: string;
}): ProjectAgentConfigureInput {
  const name = input.name.trim();
  if (!name || name.length > 160) throw new Error("Choose a name of 1–160 characters.");
  if (!input.instructions.trim() || input.instructions.length > 16_000) {
    throw new Error("Describe how your assistant should help, using up to 16,000 characters.");
  }
  const baseline = buildGroupSettingsBaseline({
    config: null,
    projectName: name,
    defaultModelSelection: input.modelSelection,
  });
  return {
    ...buildGroupConfigureInput({
      projectId: input.projectId,
      requestId: input.requestId,
      mode: "onboarding",
      baseline,
      draft: {
        ...baseline.draft,
        name,
        coordinatorIcon: input.avatar ?? MOSSBOT_DEFAULT_AVATAR_KEY,
        ...(input.color ? { coordinatorColor: input.color } : {}),
        coordinatorModelSelection: input.modelSelection,
        workerModelSelection: input.modelSelection,
        autoMemoryEnabled: true,
      },
      importedInstructions: input.instructions.trim(),
    }),
    ...(input.userLocale ? { userLocale: input.userLocale } : {}),
    agentKind: "mossbot",
    coordinatorName: name,
  };
}

/** The companion's state for an assistant: it works with a spinning sprout, waits for you, or sleeps. */
export function mossbotCompanionState(
  summary: ProjectAgentSummary,
): "idle" | "working" | "waiting" | "sleeping" {
  switch (mossbotStatus(summary)) {
    case "Working":
      return "working";
    case "Needs you":
      return "waiting";
    case "Archived":
    case "Paused":
    case "Stopped":
      return "sleeping";
    default:
      return "idle";
  }
}

export function mossbotStatus(summary: ProjectAgentSummary): string {
  if (summary.archivedAt) return "Archived";
  if (summary.pausedAt || summary.coordinatorStatus === "paused") return "Paused";
  if ((summary.needsYouThreadIds?.length ?? 0) > 0) return "Needs you";
  if (summary.coordinatorStatus === "running") return "Working";
  if (summary.coordinatorStatus === "stopped") return "Stopped";
  return "Ready";
}

/**
 * When the turn behind each member reply of a group ran, by the reply's message id. A file the
 * reply links that was created or written in that span is the member's output and gets 下载, as
 * in the main chat (WALK-6 N6-1).
 *
 * The span starts no later than the turn can have begun: at the member's previous turn's last
 * message, or at the group's creation for its first turn. The person's post is not a safe start,
 * because it may wait in the member's queue while an earlier turn still runs, and a later post
 * may come in while this turn works before its first message. The span ends with the turn's last
 * message, and stays open while that message streams or while the member is still working.
 */
export function mossbotRoomReplyFileWindows(view: {
  readonly room: Pick<MossbotRoomView["room"], "createdAt" | "deliveries">;
  readonly replies: MossbotRoomView["replies"];
}): ReadonlyMap<string, TurnFileWindow> {
  const working = new Set<string>(
    view.room.deliveries
      .filter((delivery) => delivery.state === "running")
      .map((delivery) => delivery.memberId),
  );
  const messagesByMember = new Map<string, MossbotRoomView["replies"][number]["message"][]>();
  for (const reply of view.replies) {
    const messages = messagesByMember.get(reply.memberId) ?? [];
    messages.push(reply.message);
    messagesByMember.set(reply.memberId, messages);
  }
  const windows = new Map<string, TurnFileWindow>();
  for (const [memberId, messages] of messagesByMember) {
    // One member thread runs one turn at a time, so its turns follow each other in this order.
    const turns = new Map<string, { startedAt: string; messages: typeof messages }>();
    let lastTurnMessageAt: string | null = null;
    let latestTurnId: string | null = null;
    for (const message of messages.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      // A message without a turn says nothing about when one ran: its chips keep their download.
      if (!message.turnId) continue;
      let turn = turns.get(message.turnId);
      if (!turn) {
        const groupStart =
          view.room.createdAt < message.createdAt ? view.room.createdAt : message.createdAt;
        turn = { startedAt: lastTurnMessageAt ?? groupStart, messages: [] };
        turns.set(message.turnId, turn);
      }
      turn.messages.push(message);
      lastTurnMessageAt = message.createdAt;
      latestTurnId = message.turnId;
    }
    for (const [turnId, turn] of turns) {
      const open =
        turn.messages.some((message) => message.streaming) ||
        (turnId === latestTurnId && working.has(memberId));
      const completedAt = open
        ? null
        : turn.messages
            .map((message) => message.updatedAt)
            .toSorted()
            .at(-1)!;
      const window = { startedAt: turn.startedAt, completedAt };
      for (const message of turn.messages) windows.set(message.id, window);
    }
  }
  return windows;
}
