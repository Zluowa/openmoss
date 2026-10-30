// Shared action/status semantics for every provider and the transcript/dock surfaces.
export {
  normalizeMultiAgentAction,
  isTimelineMultiAgentAction,
  normalizeMultiAgentActionStatus,
  aggregateMultiAgentActionStatus,
  normalizeMultiAgentAgentState,
  countMultiAgentActionAgents,
  type MultiAgentAction,
  type MultiAgentActionStatus,
  type MultiAgentAgentState,
} from "@synara/shared/subagentActions";
