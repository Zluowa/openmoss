// FILE: OmpSessionHistory.ts
// Purpose: Reads user-visible messages from Oh My Pi's local JSONL session store.
// Layer: Provider persistence compatibility
// Exports: readOmpSessionHistory and OmpSessionMessage.
//
// Oh My Pi keeps Pi's session format, so the shared Pi reader does the parsing.

import { findPiSessionFile, readPiSessionFile } from "./localHistory/piSessions.ts";

export interface OmpSessionMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp?: string;
}

export interface OmpSessionHistory {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly lastModel?: string;
  readonly lastThinkingLevel?: string;
  readonly messages: ReadonlyArray<OmpSessionMessage>;
}

// Filters tool/result and context rows so imports match the user-visible transcript.
export async function readOmpSessionHistory(
  agentDir: string,
  sessionId: string,
): Promise<OmpSessionHistory | null> {
  const normalizedSessionId = sessionId.trim();
  const path = await findPiSessionFile(agentDir, normalizedSessionId);
  if (!path) return null;
  const session = await readPiSessionFile(path);
  if (!session) return null;
  return {
    sessionId: normalizedSessionId,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.lastModel ? { lastModel: session.lastModel } : {}),
    ...(session.lastThinkingLevel ? { lastThinkingLevel: session.lastThinkingLevel } : {}),
    messages: session.messages.map((message): OmpSessionMessage => {
      const { id, role, text, createdAt } = message;
      return createdAt ? { id, role, text, timestamp: createdAt } : { id, role, text };
    }),
  };
}
