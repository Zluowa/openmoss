// FILE: CodexAdapter.watchdog.test.ts
// Purpose: Reproduce Codex retry-only hangs and distinguish work from bookkeeping.
// Layer: Provider adapter tests
// Exports: none

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ThreadId,
  TurnId,
  type ProviderEvent,
  type ProviderSession,
} from "@moss/contracts";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { ServerConfig } from "../../config.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { makeCodexAdapterLive } from "./CodexAdapter.ts";

const threadId = ThreadId.makeUnsafe("watchdog-thread");
const turnId = TurnId.makeUnsafe("watchdog-turn");
const idleTimeoutMs = 900_000;
const tickMs = 15_000;

// The report supplies this model, running state and activity count, but no
// original prompt, event trace or elapsed time. The retry events below are a
// synthetic reproduction of its symptom, not a claimed production transcript.
const reportedCase = {
  description: "链接一直失败，一直显示在重试。",
  model: "i-helios/gpt-6.1-sol",
  activities: 103,
};

class WatchdogManager extends CodexAppServerManager {
  session: ProviderSession = {
    provider: "codex",
    providerInstanceId: "codex_custom",
    model: reportedCase.model,
    threadId,
    activeTurnId: turnId,
    status: "running",
    runtimeMode: "full-access",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  awaitingHuman = false;

  override listSessions() {
    return [this.session];
  }

  override getSessionEventOrigin() {
    return {
      providerInstanceId: this.session.providerInstanceId,
      codexOptions: undefined,
      validationKey: this.session,
      rejectInspection: () => {},
      inspect: async () => ({ session: this.session }),
      isAuthRejected: () => false,
    };
  }

  override isTurnActive(candidateThreadId: ThreadId, candidateTurnId: TurnId) {
    return (
      candidateThreadId === threadId &&
      candidateTurnId === turnId &&
      this.session.status === "running"
    );
  }

  override isAwaitingHumanResponse() {
    return this.awaitingHuman;
  }

  override abandonTurn = vi.fn(async () => {});
  override async stopAll() {}
}

function emit(
  manager: WatchdogManager,
  method: string,
  payload: unknown = {},
  eventTurnId: TurnId | undefined = turnId,
) {
  manager.emit("event", {
    id: EventId.makeUnsafe(`event-${method}-${Date.now()}`),
    kind: "notification",
    provider: "codex",
    threadId,
    turnId: eventTurnId,
    createdAt: new Date().toISOString(),
    method,
    payload,
  } satisfies ProviderEvent);
}

async function withWatchdog(
  check: (manager: WatchdogManager) => void,
  providerInstanceId = "codex_custom",
) {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const manager = new WatchdogManager();
  manager.session = { ...manager.session, providerInstanceId };
  const layer = makeCodexAdapterLive({ manager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* CodexAdapter;
      const runningSession = manager.session;
      // Match the real manager: publish turn/started before updating session state.
      manager.session = { ...runningSession, status: "ready", activeTurnId: undefined };
      emit(manager, "turn/started", { turn: { id: turnId, model: reportedCase.model } });
      manager.session = runningSession;
      check(manager);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex turn idle progress", () => {
  it(`bounds retry-only activity: ${reportedCase.description}`, async () => {
    await withWatchdog((manager) => {
      for (let index = 0; index < reportedCase.activities; index++) {
        emit(manager, "error", {
          error: { message: "Reconnecting... 2/5" },
          willRetry: true,
        });
        vi.advanceTimersByTime(9_000);
      }
      expect(manager.abandonTurn).toHaveBeenCalledTimes(1);
      expect(manager.abandonTurn).toHaveBeenCalledWith(threadId, turnId, expect.any(String));
      vi.advanceTimersByTime(idleTimeoutMs);
      expect(manager.abandonTurn).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["thread/tokenUsage/updated", { tokenUsage: { last: { totalTokens: 1 } } }],
    ["thread/status/changed", { state: "running" }],
    ["warning", { message: "Still connecting" }],
    ["unknown/heartbeat", {}],
    ["remoteControl/status/changed", {}],
    ["item/agentMessage/delta", { delta: "" }],
    ["turn/started", { turn: { id: turnId } }],
  ])("does not let %s postpone the idle deadline", async (method, payload) => {
    await withWatchdog((manager) => {
      vi.advanceTimersByTime(idleTimeoutMs - tickMs);
      emit(manager, method, payload);
      vi.advanceTimersByTime(tickMs);
      expect(manager.abandonTurn).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["item/agentMessage/delta", { delta: "Working" }],
    ["item/reasoning/textDelta", { delta: "Thinking" }],
    ["item/commandExecution/outputDelta", { delta: "Output" }],
    ["item/started", { item: { id: "command", type: "commandExecution" } }],
    ["item/mcpToolCall/progress", { summary: "Working" }],
    ["thread/compacting", {}],
    ["turn/plan/updated", { plan: [{ step: "Check", status: "in_progress" }] }],
    ["turn/diff/updated", { diff: "+updated" }],
    ["item/plan/delta", { delta: "Plan" }],
    ["codex/event/task_started", { id: "child-task", msg: { turn_id: turnId } }],
    ["hook/started", { run: { id: "hook", eventName: "PreToolUse", handlerType: "command" } }],
  ])("keeps legitimate work alive for %s", async (method, payload) => {
    await withWatchdog((manager) => {
      vi.advanceTimersByTime(idleTimeoutMs - tickMs);
      emit(manager, method, payload);
      vi.advanceTimersByTime(tickMs);
      expect(manager.abandonTurn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(idleTimeoutMs - tickMs);
      expect(manager.abandonTurn).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores output belonging to an old turn", async () => {
    await withWatchdog((manager) => {
      vi.advanceTimersByTime(idleTimeoutMs - tickMs);
      const oldTurnId = TurnId.makeUnsafe("old-turn");
      emit(manager, "item/agentMessage/delta", { delta: "Old output" }, oldTurnId);
      vi.advanceTimersByTime(tickMs);
      expect(manager.abandonTurn).toHaveBeenCalledWith(threadId, turnId, expect.any(String));
    });
  });

  it("pauses while awaiting a human and gives a full idle window afterwards", async () => {
    await withWatchdog((manager) => {
      manager.awaitingHuman = true;
      vi.advanceTimersByTime(idleTimeoutMs * 2);
      expect(manager.abandonTurn).not.toHaveBeenCalled();
      manager.awaitingHuman = false;
      vi.advanceTimersByTime(idleTimeoutMs - tickMs);
      expect(manager.abandonTurn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(tickMs);
      expect(manager.abandonTurn).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the managed first-activity deadline through repeated starts and retries", async () => {
    await withWatchdog((manager) => {
      for (let index = 0; index < 10; index++) {
        emit(manager, "turn/started", { turn: { id: turnId } });
        emit(manager, "error", { error: { message: "Reconnecting... 2/5" }, willRetry: true });
        vi.advanceTimersByTime(tickMs);
      }
      expect(manager.abandonTurn).toHaveBeenCalledTimes(1);
    }, "codex_moss");
  });

  it("does not restore the managed first-activity deadline after real progress", async () => {
    await withWatchdog((manager) => {
      emit(manager, "item/agentMessage/delta", { delta: "Started" });
      vi.advanceTimersByTime(tickMs);
      emit(manager, "turn/started", { turn: { id: turnId } });
      vi.advanceTimersByTime(150_000);
      expect(manager.abandonTurn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(idleTimeoutMs - 150_000 - tickMs);
      expect(manager.abandonTurn).toHaveBeenCalledTimes(1);
    }, "codex_moss");
  });

  it("still bounds retries after a managed turn has produced its first output", async () => {
    await withWatchdog((manager) => {
      emit(manager, "item/agentMessage/delta", { delta: "Started" });
      for (let index = 0; index < 60; index++) {
        emit(manager, "error", { error: { message: "Reconnecting... 2/5" }, willRetry: true });
        vi.advanceTimersByTime(tickMs);
      }
      expect(manager.abandonTurn).toHaveBeenCalledTimes(1);
    }, "codex_moss");
  });
});
