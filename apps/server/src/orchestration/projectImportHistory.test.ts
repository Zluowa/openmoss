import { ThreadId } from "@moss/contracts";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import { makeProjectImportHistoryReader } from "./projectImportHistory";

const { readMessagePage, readDates } = vi.hoisted(() => ({
  readMessagePage: vi.fn(async () => ({ messages: [], nextCursor: null })),
  readDates: vi.fn(async () => new Map<string, string>()),
}));
vi.mock("../provider/claudeAgentSdk", () => ({
  readClaudeSessionMessagePageInEnvironment: readMessagePage,
}));
vi.mock("../provider/claudeProjectImport", () => ({ readClaudeImportMessageDates: readDates }));

it("reads the frozen Claude copy from its source project, not the destination workspace", async () => {
  const reader = makeProjectImportHistoryReader({} as ProviderAdapterRegistryShape);
  await Effect.runPromise(
    reader({
      provider: "claudeAgent",
      threadId: ThreadId.makeUnsafe("imported-thread"),
      nativeId: "frozen-copy",
      sourceHome: "/selected-claude-home",
      sourceCwd: "/original-project",
      claudeEnvironment: { CLAUDE_CONFIG_DIR: "/selected-claude-home" },
      cwd: "/new-destination",
      sourceCreatedAt: "2026-09-01T00:00:00.000Z",
    }),
  );
  expect(readMessagePage).toHaveBeenCalledWith({
    sessionId: "frozen-copy",
    dir: "/original-project",
    environment: { CLAUDE_CONFIG_DIR: "/selected-claude-home" },
  });
  expect(readDates).toHaveBeenCalledWith({
    sessionId: "frozen-copy",
    configDir: "/selected-claude-home",
  });
});

it("imports a recent Codex page without requesting an oversized full transcript", async () => {
  const reader = makeProjectImportHistoryReader({
    getByProvider: () =>
      Effect.succeed({
        hasSession: () => Effect.succeed(true),
        readThread: () => Effect.fail(new Error("JSONL frame exceeded its byte limit")),
        readExternalThreadPage: () =>
          Effect.succeed({
            threadId: "frozen-copy",
            turns: [
              {
                id: "last-turn",
                items: [{ id: "reply", type: "agentMessage", text: "Latest answer" }],
              },
            ],
            nextCursor: "older-turns",
          }),
      }),
  } as unknown as ProviderAdapterRegistryShape);
  const page = await Effect.runPromise(
    reader({
      provider: "codex",
      threadId: ThreadId.makeUnsafe("imported-thread"),
      nativeId: "frozen-copy",
      sourceHome: "/codex",
      sourceCwd: "/project",
      sourceCreatedAt: "2026-09-01T00:00:00.000Z",
    }),
  );
  expect(page).toMatchObject({ messages: [{ text: "Latest answer" }], nextCursor: "older-turns" });
});
