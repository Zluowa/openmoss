import { ThreadId, TurnId } from "@moss/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPageAssistantKeeper,
  pageAssistantThreads,
  pageRunProgress,
  sendPageAssistantTurn,
} from "./pageAssistantThread";

const PAGE = "account:local:page-1";
const OLD = ThreadId.makeUnsafe("thread-old");
const NEW = ThreadId.makeUnsafe("thread-new");

function fakeTimers() {
  let clock = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextId = 1;
  return {
    now: () => clock,
    setTimer: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    advance: (ms: number) => {
      clock += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.run();
        }
      }
    },
  };
}

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
  });
  pageAssistantThreads.resetForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  pageAssistantThreads.resetForTests();
});

describe("pageAssistantThreads", () => {
  it("remembers a page's chat across reloads and forgets only that chat", () => {
    pageAssistantThreads.set(PAGE, OLD);
    pageAssistantThreads.resetForTests();
    expect(pageAssistantThreads.get(PAGE)).toBe(OLD);
    pageAssistantThreads.forget(PAGE, NEW);
    expect(pageAssistantThreads.get(PAGE)).toBe(OLD);
    pageAssistantThreads.forget(PAGE, OLD);
    expect(pageAssistantThreads.get(PAGE)).toBeNull();
  });
});

describe("sendPageAssistantTurn", () => {
  const summary = { id: OLD, latestTurn: { turnId: TurnId.makeUnsafe("turn-1") } };

  it("sends a follow-up into the page's chat instead of making a new one", async () => {
    const startNewChat = vi.fn(async () => NEW);
    const sendToExisting = vi.fn(async () => ({ kind: "dispatched" as const }));
    const result = await sendPageAssistantTurn({
      pageKey: PAGE,
      reusable: () => summary,
      sendToExisting,
      discardUnsent: vi.fn(),
      startNewChat,
    });
    expect(result).toEqual({ threadId: OLD, baselineTurnId: "turn-1", reused: true });
    expect(sendToExisting).toHaveBeenCalledWith(summary);
    expect(startNewChat).not.toHaveBeenCalled();
  });

  it("makes the page's chat on first use and remembers it", async () => {
    const result = await sendPageAssistantTurn({
      pageKey: PAGE,
      reusable: () => null,
      sendToExisting: vi.fn(),
      discardUnsent: vi.fn(),
      startNewChat: async () => NEW,
    });
    expect(result).toEqual({ threadId: NEW, baselineTurnId: null, reused: false });
    expect(pageAssistantThreads.get(PAGE)).toBe(NEW);
  });

  it("falls back to a new chat when the page's chat refuses the send", async () => {
    pageAssistantThreads.set(PAGE, OLD);
    const discardUnsent = vi.fn();
    const result = await sendPageAssistantTurn({
      pageKey: PAGE,
      reusable: () => summary,
      sendToExisting: async () => ({ kind: "error", message: "busy" }),
      discardUnsent,
      startNewChat: async () => NEW,
    });
    expect(discardUnsent).toHaveBeenCalledWith(OLD);
    expect(result.threadId).toBe(NEW);
    expect(pageAssistantThreads.get(PAGE)).toBe(NEW);
  });

  it("never repeats a send that may have reached the agent", async () => {
    const startNewChat = vi.fn(async () => NEW);
    await expect(
      sendPageAssistantTurn({
        pageKey: PAGE,
        reusable: () => summary,
        sendToExisting: async () => ({
          kind: "error",
          message: "connection lost",
          outcomeUnknown: true,
        }),
        discardUnsent: vi.fn(),
        startNewChat,
      }),
    ).rejects.toThrow("connection lost");
    expect(startNewChat).not.toHaveBeenCalled();
  });
});

describe("createPageAssistantKeeper", () => {
  const setup = (busy = { value: false }) => {
    const timers = fakeTimers();
    const warm = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const keeper = createPageAssistantKeeper({
      warm,
      release,
      isBusy: () => busy.value,
      idleMs: 60_000,
      ...timers,
    });
    return { timers, warm, release, keeper, busy };
  };

  it("starts the agent once for repeated opens", () => {
    const { keeper, warm, timers } = setup();
    keeper.warm(OLD);
    keeper.warm(OLD);
    timers.advance(10_000);
    keeper.warm(OLD);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("stops the agent after a quiet spell, and activity pushes the stop back", () => {
    const { keeper, release, timers } = setup();
    keeper.warm(OLD);
    timers.advance(50_000);
    keeper.touch(OLD);
    timers.advance(50_000);
    expect(release).not.toHaveBeenCalled();
    timers.advance(10_000);
    expect(release).toHaveBeenCalledWith(OLD);
  });

  it("never stops the agent under a running turn", () => {
    const { keeper, release, timers, busy } = setup({ value: true });
    keeper.warm(OLD);
    timers.advance(60_000);
    expect(release).not.toHaveBeenCalled();
    busy.value = false;
    timers.advance(60_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("stops the agent when the page closes, and warms again after a stop", () => {
    const { keeper, release, warm, timers } = setup();
    keeper.warm(OLD);
    timers.advance(60_000);
    expect(release).toHaveBeenCalledTimes(1);
    keeper.warm(OLD);
    expect(warm).toHaveBeenCalledTimes(2);
    keeper.dispose();
    expect(release).toHaveBeenCalledTimes(2);
    keeper.warm(OLD);
    expect(warm).toHaveBeenCalledTimes(2);
  });

  it("does nothing on close for a page whose assistant was never used", () => {
    const { keeper, release } = setup();
    keeper.dispose();
    expect(release).not.toHaveBeenCalled();
  });

  it("tries again after a failed warm-up", async () => {
    const timers = fakeTimers();
    const warm = vi.fn(async () => {
      throw new Error("offline");
    });
    const keeper = createPageAssistantKeeper({
      warm,
      release: async () => undefined,
      isBusy: () => false,
      ...timers,
    });
    keeper.warm(OLD);
    await Promise.resolve();
    await Promise.resolve();
    keeper.warm(OLD);
    expect(warm).toHaveBeenCalledTimes(2);
  });
});

const at = (ms: number) => new Date(ms).toISOString();

describe("pageRunProgress", () => {
  const thread = {
    latestTurn: { turnId: TurnId.makeUnsafe("turn-1"), state: "completed" },
    session: { status: "ready", updatedAt: at(1_000) },
    messages: [
      { role: "user", text: "first", createdAt: at(1_000), streaming: false },
      { role: "assistant", text: "old reply", createdAt: at(2_000), streaming: false },
    ],
  };

  it("waits for the run's own turn in a reused chat", () => {
    expect(pageRunProgress(thread, TurnId.makeUnsafe("turn-1"), 100_000)).toEqual({
      state: "pending",
      reply: "",
    });
  });

  it("reads only the run's own reply", () => {
    const next = {
      ...thread,
      latestTurn: { turnId: TurnId.makeUnsafe("turn-2"), state: "completed" },
      messages: [
        ...thread.messages,
        { role: "user", text: "second", createdAt: at(100_100), streaming: false },
        { role: "assistant", text: "new reply", createdAt: at(100_200), streaming: false },
      ],
    };
    expect(pageRunProgress(next, TurnId.makeUnsafe("turn-1"), 100_000)).toEqual({
      state: "completed",
      reply: "new reply",
    });
  });

  it("reads a new chat as before", () => {
    expect(pageRunProgress(thread, null, 0)).toEqual({ state: "completed", reply: "old reply" });
  });

  it("ignores a failed session left over from before the run", () => {
    const failed = {
      latestTurn: null,
      session: { status: "error", updatedAt: at(1_000) },
      messages: [],
    };
    expect(pageRunProgress(failed, null, 100_000).state).toBe("pending");
    expect(pageRunProgress(failed, null, 0).state).toBe("error");
  });
});
