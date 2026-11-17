// One owner for the order of a Codex session's forks: the composer prediction goes first and
// is never delayed by a title; a title waits for it and starts again when a prediction stops
// it. A fork that starts a tool is interrupted. (Round 20261117-owner-test, lead review 1-3.)
import { ThreadId, TurnId } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager.ts";

const threadId = ThreadId.makeUnsafe("thread_1");
const sourceTurnId = TurnId.makeUnsafe("turn_parent_done");

type Notification = { readonly method: string; readonly params?: unknown };

type ManagerInternals = {
  readonly sessions: Map<string, unknown>;
  handleServerNotification: (context: unknown, notification: Notification) => void;
};

const PREDICTION = {
  prompt: "PREDICT the next message",
  sourceTurnId,
  generationTrigger: "live" as const,
  timeoutMs: 20_000,
  effort: "low",
};
const TITLE = { ...PREDICTION, prompt: "TITLE for the conversation", purpose: "title" as const };

interface ForkTurn {
  readonly forkId: string;
  readonly turnId: string;
  readonly prompt: string;
  /** Ends the fork's turn with this final message. */
  readonly complete: (text: string) => void;
}

function createHarness() {
  const manager = new CodexAppServerManager();
  const internals = manager as unknown as ManagerInternals;
  const context = {
    lifecycleGeneration: "generation-a",
    appServerVersion: "0.163.0",
    session: {
      provider: "codex",
      status: "ready",
      threadId,
      runtimeMode: "full-access",
      model: "gpt-6.1-terra",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "provider_parent" },
      createdAt: "2026-11-17T00:00:00.000Z",
      updatedAt: "2026-11-17T00:00:00.000Z",
    },
    account: { type: "unknown", planType: null, sparkEnabled: true },
    child: {
      exitCode: null,
      signalCode: null,
      killed: false,
      stdin: { writable: true, writableEnded: false, destroyed: false },
    },
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map<string, string>(),
    collabReceiverParents: new Map<string, string>(),
    reviewTurnIds: new Set<string>(),
    nextRequestId: 1,
    stopping: false,
  };
  internals.sessions.set(threadId, context);
  const notify = (notification: Notification) =>
    internals.handleServerNotification(context, notification);
  vi.spyOn(
    manager as unknown as { emitEvent: (...args: unknown[]) => void },
    "emitEvent",
  ).mockImplementation(() => {});
  vi.spyOn(
    manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
    "writeMessage",
  ).mockResolvedValue(undefined);

  let forks = 0;
  const turns: ForkTurn[] = [];
  const interrupted: string[] = [];
  const calls: string[] = [];
  vi.spyOn(
    manager as unknown as {
      sendRequest: (context: unknown, method: string, params: unknown) => Promise<unknown>;
    },
    "sendRequest",
  ).mockImplementation(async (_context, method, rawParams) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    calls.push(method);
    if (method === "thread/fork") {
      forks += 1;
      return { thread: { id: `fork_${forks}` } };
    }
    if (method === "turn/start") {
      const forkId = String(params.threadId);
      const turnId = `turn_${forkId}`;
      const input = params.input as Array<{ text: string }>;
      const turn: ForkTurn = {
        forkId,
        turnId,
        prompt: input[0]!.text,
        complete: (text) => {
          notify({
            method: "item/completed",
            params: { threadId: forkId, turnId, item: { type: "agentMessage", text } },
          });
          notify({
            method: "turn/completed",
            params: { threadId: forkId, turn: { id: turnId, status: "completed" } },
          });
        },
      };
      turns.push(turn);
      queueMicrotask(() =>
        notify({ method: "turn/started", params: { threadId: forkId, turn: { id: turnId } } }),
      );
      return { turn: { id: turnId } };
    }
    if (method === "turn/interrupt") {
      const forkId = String(params.threadId);
      interrupted.push(forkId);
      queueMicrotask(() =>
        notify({
          method: "turn/completed",
          params: {
            threadId: forkId,
            turn: { id: String(params.turnId), status: "interrupted" },
          },
        }),
      );
      return {};
    }
    return {};
  });
  const turnFor = async (marker: string, index = 0) => {
    await vi.waitFor(() =>
      expect(turns.filter((turn) => turn.prompt.startsWith(marker)).length).toBeGreaterThan(index),
    );
    return turns.filter((turn) => turn.prompt.startsWith(marker))[index]!;
  };
  return { manager, context, notify, turns, interrupted, calls, turnFor };
}

describe("the order of a Codex session's forks", () => {
  it("lets the suggestion stop a running title fork, then writes the title", async () => {
    const harness = createHarness();
    const title = harness.manager.predictNextUserMessage(threadId, TITLE);
    const firstTitleTurn = await harness.turnFor("TITLE");

    const prediction = harness.manager.predictNextUserMessage(threadId, PREDICTION);
    const predictionTurn = await harness.turnFor("PREDICT");
    // The title fork was interrupted for it, not left to run beside it.
    expect(harness.interrupted).toEqual([firstTitleTurn.forkId]);
    predictionTurn.complete('{"suggestion":"保持这样"}');
    await expect(prediction).resolves.toEqual({
      kind: "predicted",
      text: '{"suggestion":"保持这样"}',
    });

    // The title starts again once the prediction is done.
    const secondTitleTurn = await harness.turnFor("TITLE", 1);
    secondTitleTurn.complete('{"title":"透明二次元聊天背景"}');
    await expect(title).resolves.toEqual({
      kind: "predicted",
      text: '{"title":"透明二次元聊天背景"}',
    });
    expect(harness.turns.map((turn) => turn.prompt.split(" ")[0])).toEqual([
      "TITLE",
      "PREDICT",
      "TITLE",
    ]);
  });

  it("starts a title fork only after a running prediction fork is done", async () => {
    const harness = createHarness();
    const prediction = harness.manager.predictNextUserMessage(threadId, PREDICTION);
    const predictionTurn = await harness.turnFor("PREDICT");

    const title = harness.manager.predictNextUserMessage(threadId, TITLE);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.calls.filter((method) => method === "thread/fork")).toHaveLength(1);
    expect(harness.interrupted).toEqual([]);

    predictionTurn.complete('{"suggestion":null}');
    await prediction;
    const titleTurn = await harness.turnFor("TITLE");
    titleTurn.complete('{"title":"Fix the login race"}');
    await expect(title).resolves.toMatchObject({ kind: "predicted" });
  });

  it("still answers a second prediction as busy while one runs", async () => {
    const harness = createHarness();
    const first = harness.manager.predictNextUserMessage(threadId, PREDICTION);
    const firstTurn = await harness.turnFor("PREDICT");
    await expect(harness.manager.predictNextUserMessage(threadId, PREDICTION)).resolves.toEqual({
      kind: "skipped",
      reason: "prediction_in_flight",
    });
    firstTurn.complete('{"suggestion":null}');
    await first;
  });

  it("leaves a title for later while the parent thread is working", async () => {
    const harness = createHarness();
    harness.context.session.activeTurnId = "turn_parent_next";
    await expect(harness.manager.predictNextUserMessage(threadId, TITLE)).resolves.toEqual({
      kind: "skipped",
      reason: "parent_turn_active",
    });
    expect(harness.calls).not.toContain("thread/fork");
  });

  it.each(["commandExecution", "fileChange", "mcpToolCall"])(
    "interrupts a fork that starts a %s item",
    async (itemType) => {
      const harness = createHarness();
      const title = harness.manager.predictNextUserMessage(threadId, TITLE);
      const turn = await harness.turnFor("TITLE");
      harness.notify({
        method: "item/started",
        params: {
          threadId: turn.forkId,
          turnId: turn.turnId,
          item: { type: itemType, id: "item_1" },
        },
      });

      await expect(title).rejects.toThrow(`The Codex fork started a ${itemType} item.`);
      expect(harness.interrupted).toEqual([turn.forkId]);
    },
  );

  it("lets a fork think and answer", async () => {
    const harness = createHarness();
    const prediction = harness.manager.predictNextUserMessage(threadId, PREDICTION);
    const turn = await harness.turnFor("PREDICT");
    harness.notify({
      method: "item/started",
      params: { threadId: turn.forkId, turnId: turn.turnId, item: { type: "reasoning" } },
    });
    turn.complete('{"suggestion":"Ship it."}');
    await expect(prediction).resolves.toMatchObject({ kind: "predicted" });
    expect(harness.interrupted).toEqual([]);
  });
});
