import { ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { CODEX_PREDICTION_THREAD_SOURCE, CodexAppServerManager } from "./codexAppServerManager.ts";

const threadId = ThreadId.makeUnsafe("thread_1");
const sourceTurnId = TurnId.makeUnsafe("turn_parent_done");
const forkThreadId = "fork_prediction_1";
const forkTurnId = "turn_fork_1";

type Notification = { readonly method: string; readonly params?: unknown };

type ManagerInternals = {
  readonly sessions: Map<string, unknown>;
  handleServerNotification: (context: unknown, notification: Notification) => void;
  handleServerRequest: (context: unknown, request: Record<string, unknown>) => Promise<void>;
  rejectPendingRequests: (context: unknown, error: Error) => void;
  initializeAppServer: (context: unknown) => Promise<void>;
};

function createPredictionHarness(options?: { readonly appServerVersion?: string }) {
  const manager = new CodexAppServerManager();
  const internals = manager as unknown as ManagerInternals;
  const context = {
    lifecycleGeneration: "generation-a",
    appServerVersion: options?.appServerVersion ?? "0.163.0",
    session: {
      provider: "codex",
      status: "ready",
      threadId,
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "provider_parent" },
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
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
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});
  const writeMessage = vi
    .spyOn(
      manager as unknown as { writeMessage: (...args: unknown[]) => Promise<void> },
      "writeMessage",
    )
    .mockResolvedValue(undefined);
  const sendRequest = vi.spyOn(
    manager as unknown as {
      sendRequest: (context: unknown, method: string, params: unknown) => Promise<unknown>;
    },
    "sendRequest",
  );

  return { manager, internals, context, notify, emitEvent, writeMessage, sendRequest };
}

const forkStarted = (id = forkThreadId): Notification => ({
  method: "thread/started",
  params: {
    thread: {
      id,
      forkedFromId: "provider_parent",
      ephemeral: true,
      threadSource: CODEX_PREDICTION_THREAD_SOURCE,
    },
  },
});

const predictionInput = {
  prompt: "Predict.\n\nReturn only JSON matching this schema: {}.",
  sourceTurnId,
  generationTrigger: "live" as const,
  timeoutMs: 30_000,
  effort: "low",
};

describe("CodexAppServerManager.predictNextUserMessage", () => {
  it("forks the idle parent in prediction mode and collects the structured turn", async () => {
    const { manager, notify, emitEvent, sendRequest } = createPredictionHarness();
    sendRequest.mockImplementation(async (_context, method) => {
      if (method === "thread/fork") {
        // App-server can announce the fork before answering the request.
        notify(forkStarted());
        notify({ method: "thread/settings/updated", params: { threadId: forkThreadId } });
        return { thread: { id: forkThreadId } };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          notify({
            method: "turn/started",
            params: { threadId: forkThreadId, turn: { id: forkTurnId } },
          });
          notify({
            method: "thread/tokenUsage/updated",
            params: { threadId: forkThreadId, turnId: forkTurnId, tokenUsage: {} },
          });
          notify({
            method: "item/agentMessage/delta",
            params: { threadId: forkThreadId, turnId: forkTurnId, delta: '{"suggestion":' },
          });
          notify({
            method: "item/agentMessage/delta",
            params: { threadId: forkThreadId, turnId: forkTurnId, delta: '"run the tests"}' },
          });
          notify({
            method: "turn/completed",
            params: { threadId: forkThreadId, turn: { id: forkTurnId, status: "completed" } },
          });
        });
        return { turn: { id: forkTurnId } };
      }
      return {};
    });

    await expect(manager.predictNextUserMessage(threadId, predictionInput)).resolves.toEqual({
      kind: "predicted",
      text: '{"suggestion":"run the tests"}',
    });

    expect(sendRequest.mock.calls.map(([, method, params]) => [method, params])).toEqual([
      [
        "thread/fork",
        {
          threadId: "provider_parent",
          experimentalPredictionMode: true,
          ephemeral: true,
          excludeTurns: true,
          threadSource: "composer_predictions",
        },
      ],
      [
        "turn/start",
        {
          threadId: forkThreadId,
          turnTrigger: "composer_predictions",
          responsesapiClientMetadata: {
            prediction_source_thread_id: "provider_parent",
            prediction_source_turn_id: "turn_parent_done",
            prediction_trigger: "live",
          },
          clientUserMessageId: expect.any(String),
          input: [{ type: "text", text: predictionInput.prompt, text_elements: [] }],
          effort: "low",
          outputSchema: null,
        },
      ],
      ["thread/unsubscribe", { threadId: forkThreadId }],
    ]);
    // Nothing from the fork, its token usage included, reaches the parent conversation.
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("keeps a retired fork's late notifications away from the parent", async () => {
    const { manager, notify, emitEvent, sendRequest } = createPredictionHarness();
    sendRequest.mockImplementation(async (_context, method) => {
      if (method === "thread/fork") return { thread: { id: forkThreadId } };
      if (method === "turn/start") {
        queueMicrotask(() =>
          notify({
            method: "turn/completed",
            params: { threadId: forkThreadId, turn: { id: forkTurnId, status: "completed" } },
          }),
        );
        return { turn: { id: forkTurnId } };
      }
      return {};
    });

    await expect(manager.predictNextUserMessage(threadId, predictionInput)).resolves.toEqual({
      kind: "predicted",
      text: null,
    });
    notify(forkStarted());
    notify({ method: "thread/closed", params: { threadId: forkThreadId } });
    expect(emitEvent).not.toHaveBeenCalled();

    // The parent conversation still routes normally.
    notify({
      method: "item/agentMessage/delta",
      params: { threadId: "provider_parent", turnId: "turn_parent_done", delta: "hi" },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ method: "item/agentMessage/delta", threadId }),
    );
  });

  it("reports why the native fork is unavailable without sending anything", async () => {
    const tooOld = createPredictionHarness({ appServerVersion: "0.162.0-alpha.19" });
    await expect(tooOld.manager.predictNextUserMessage(threadId, predictionInput)).resolves.toEqual(
      { kind: "unsupported", reason: "app_server_without_prediction_fork" },
    );
    expect(tooOld.sendRequest).not.toHaveBeenCalled();

    const missing = createPredictionHarness();
    await expect(
      missing.manager.predictNextUserMessage(ThreadId.makeUnsafe("thread_other"), predictionInput),
    ).resolves.toEqual({ kind: "unsupported", reason: "no_live_session" });

    const busy = createPredictionHarness();
    busy.context.session.activeTurnId = "turn_running";
    await expect(busy.manager.predictNextUserMessage(threadId, predictionInput)).resolves.toEqual({
      kind: "skipped",
      reason: "parent_turn_active",
    });
    expect(busy.sendRequest).not.toHaveBeenCalled();
  });

  it("does not fall back to a fresh thread when app-server rejects the fork", async () => {
    const { manager, sendRequest } = createPredictionHarness();
    sendRequest.mockRejectedValue(new Error("thread/fork failed: no rollout found"));

    await expect(manager.predictNextUserMessage(threadId, predictionInput)).resolves.toEqual({
      kind: "unsupported",
      reason: "prediction_fork_rejected",
    });
    expect(sendRequest.mock.calls.map(([, method]) => method)).toEqual(["thread/fork"]);
  });

  it("interrupts the fork turn at the deadline and still unsubscribes", async () => {
    const { manager, sendRequest } = createPredictionHarness();
    sendRequest.mockImplementation(async (_context, method) => {
      if (method === "thread/fork") return { thread: { id: forkThreadId } };
      if (method === "turn/start") return { turn: { id: forkTurnId } };
      return {};
    });

    await expect(
      manager.predictNextUserMessage(threadId, { ...predictionInput, timeoutMs: 5 }),
    ).rejects.toThrow("Timed out waiting for the Codex prediction.");
    expect(sendRequest.mock.calls.map(([, method, params]) => [method, params]).slice(2)).toEqual([
      ["turn/interrupt", { threadId: forkThreadId, turnId: forkTurnId }],
      ["thread/unsubscribe", { threadId: forkThreadId }],
    ]);
  });

  it("interrupts once the turn id arrives when the caller aborts first", async () => {
    const { manager, sendRequest } = createPredictionHarness();
    const controller = new AbortController();
    let resolveTurnStart: ((value: unknown) => void) | undefined;
    sendRequest.mockImplementation((_context, method) => {
      if (method === "thread/fork") return Promise.resolve({ thread: { id: forkThreadId } });
      if (method === "turn/start") {
        return new Promise((resolve) => {
          resolveTurnStart = resolve;
          controller.abort();
        });
      }
      return Promise.resolve({});
    });

    await expect(
      manager.predictNextUserMessage(threadId, predictionInput, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    resolveTurnStart?.({ turn: { id: forkTurnId } });
    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith(expect.anything(), "turn/interrupt", {
        threadId: forkThreadId,
        turnId: forkTurnId,
      }),
    );
  });

  it("surfaces a failed fork turn with Codex's error detail", async () => {
    const { manager, notify, sendRequest } = createPredictionHarness();
    sendRequest.mockImplementation(async (_context, method) => {
      if (method === "thread/fork") return { thread: { id: forkThreadId } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          notify({
            method: "error",
            params: {
              threadId: forkThreadId,
              turnId: forkTurnId,
              willRetry: false,
              error: { message: "unexpected status 401 Unauthorized" },
            },
          });
          notify({
            method: "turn/completed",
            params: { threadId: forkThreadId, turn: { id: forkTurnId, status: "failed" } },
          });
        });
        return { turn: { id: forkTurnId } };
      }
      return {};
    });

    await expect(manager.predictNextUserMessage(threadId, predictionInput)).rejects.toThrow(
      "Codex prediction turn ended as failed: unexpected status 401 Unauthorized",
    );
  });

  it("fails an in-flight prediction when the app-server goes away", async () => {
    const { manager, internals, context, sendRequest } = createPredictionHarness();
    sendRequest.mockImplementation(async (_context, method) => {
      if (method === "thread/fork") return { thread: { id: forkThreadId } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          context.stopping = true;
          internals.rejectPendingRequests(context, new Error("Session stopped."));
        });
        return { turn: { id: forkTurnId } };
      }
      return {};
    });

    await expect(manager.predictNextUserMessage(threadId, predictionInput)).rejects.toThrow(
      "Session stopped.",
    );
    // A stopped app-server is not asked to interrupt or unsubscribe.
    expect(sendRequest.mock.calls.map(([, method]) => method)).toEqual([
      "thread/fork",
      "turn/start",
    ]);
  });

  it("declines server requests from a prediction fork", async () => {
    const { internals, context, notify, emitEvent, writeMessage } = createPredictionHarness();
    notify(forkStarted());

    await internals.handleServerRequest(context, {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: forkThreadId, turnId: forkTurnId, itemId: "call_1" },
    });

    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 7,
      error: {
        code: -32601,
        message:
          "Moss declines item/commandExecution/requestApproval from a composer prediction thread.",
      },
    });
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe("CodexAppServerManager initialize handshake", () => {
  it("records the app-server build from the initialize userAgent", async () => {
    const { internals, context, sendRequest, writeMessage } = createPredictionHarness();
    const unversioned = { ...context, appServerVersion: undefined as string | undefined };
    sendRequest.mockResolvedValue({
      userAgent: "moss_desktop/0.163.0 (Ubuntu 24.4.0; x86_64) unknown",
      codexHome: "/home/user/.codex",
    });

    await internals.initializeAppServer(unversioned);

    expect(unversioned.appServerVersion).toBe("0.163.0");
    // The handshake has its own 90s budget: a large Codex home takes ~17s to load.
    expect(sendRequest).toHaveBeenCalledWith(
      unversioned,
      "initialize",
      {
        clientInfo: { name: "moss_desktop", title: "Moss Desktop", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      90_000,
    );
    expect(writeMessage).toHaveBeenCalledWith(unversioned, { method: "initialized" });
  });
});
