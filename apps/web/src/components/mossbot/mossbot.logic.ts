import type {
  ModelSelection,
  ProjectAgentConfigureInput,
  ProjectAgentSummary,
  ProjectId,
  ThreadId,
} from "@moss/contracts";
import {
  buildGroupConfigureInput,
  buildGroupSettingsBaseline,
} from "../chat/group/groupSettingsDialog.logic";

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
        coordinatorIcon: input.avatar ?? "mossbot-pebble",
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

export function mossbotStatus(summary: ProjectAgentSummary): string {
  if (summary.archivedAt) return "Archived";
  if (summary.pausedAt || summary.coordinatorStatus === "paused") return "Paused";
  if ((summary.needsYouThreadIds?.length ?? 0) > 0) return "Needs you";
  if (summary.coordinatorStatus === "running") return "Working";
  if (summary.coordinatorStatus === "stopped") return "Stopped";
  return "Ready";
}
