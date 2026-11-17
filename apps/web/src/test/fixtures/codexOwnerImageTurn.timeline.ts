// FILE: codexOwnerImageTurn.timeline.ts
// Purpose: Builds the transcript inputs (messages, work entries, timeline entries) for the
//          real Codex turn in codexOwnerImageTurn.fixture.ts the same way ChatView does.
// Layer: Test fixture helper

import { MessageId, TurnId, type OrchestrationThreadActivity } from "@moss/contracts";

import { deriveAgentActivityTimelineState } from "../../components/chat/agentActivity.logic";
import type { ChatMessage } from "../../types";
import { deriveTimelineEntries, deriveWorkLogEntries, type WorkLogEntry } from "../../workLog";
import {
  codexOwnerImageTurn,
  codexOwnerImageTurnActivities,
  codexOwnerImageTurnMessages,
} from "./codexOwnerImageTurn.fixture";

export const codexOwnerTurnId = TurnId.makeUnsafe(codexOwnerImageTurn.turn_id);

export function codexOwnerActivities(): OrchestrationThreadActivity[] {
  return codexOwnerImageTurnActivities as unknown as OrchestrationThreadActivity[];
}

export function codexOwnerMessages(): ChatMessage[] {
  return codexOwnerImageTurnMessages.map((message) => ({
    id: MessageId.makeUnsafe(message.id),
    role: message.role as ChatMessage["role"],
    text: message.text,
    turnId: message.turnId ? TurnId.makeUnsafe(message.turnId) : null,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    ...(message.role === "assistant" ? { completedAt: message.updatedAt } : {}),
    streaming: false,
  }));
}

/** Work entries as the transcript receives them (reasoning items folded as upstream does). */
export function codexOwnerWorkEntries(): WorkLogEntry[] {
  const entries = deriveWorkLogEntries(codexOwnerActivities(), codexOwnerTurnId, {
    latestTurnState: "completed",
    latestTurnCompletedAt: codexOwnerImageTurn.completed_at,
  });
  return deriveAgentActivityTimelineState(entries).timelineWorkEntries;
}

export function codexOwnerTimelineEntries() {
  return deriveTimelineEntries(codexOwnerMessages(), [], codexOwnerWorkEntries());
}
