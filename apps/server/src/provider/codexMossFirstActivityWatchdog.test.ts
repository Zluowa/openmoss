import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventId, ThreadId, TurnId } from "@synara/contracts";

import {
  CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS,
  evaluateCodexMossFirstActivityTick,
  isCodexMossFirstActivityProgressEvent,
  resolveCodexMossFirstActivityTimeoutMs,
} from "./codexMossFirstActivityWatchdog.ts";

describe("resolveCodexMossFirstActivityTimeoutMs", () => {
  it("defaults to the shared 90s Moss first-activity constant (not a stale 15s literal)", () => {
    expect(CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS).toBe(90_000);
    expect(resolveCodexMossFirstActivityTimeoutMs({})).toBe(90_000);
    expect(resolveCodexMossFirstActivityTimeoutMs({})).not.toBe(15_000);
  });

  it("honors MOSS_CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_MS overrides", () => {
    expect(
      resolveCodexMossFirstActivityTimeoutMs({
        MOSS_CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_MS: "60000",
      }),
    ).toBe(60_000);
  });

  it("keeps CodexAdapter wired to the shared resolver (no silent 15s defaultMs)", () => {
    const adapterPath = fileURLToPath(new URL("./Layers/CodexAdapter.ts", import.meta.url));
    const source = readFileSync(adapterPath, "utf8");
    expect(source).toContain("resolveCodexMossFirstActivityTimeoutMs");
    expect(source).toMatch(
      /const CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_MS = resolveCodexMossFirstActivityTimeoutMs\(\);/,
    );
    expect(source).not.toMatch(
      /MOSS_CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_MS[\s\S]{0,120}defaultMs:\s*15_000/,
    );
  });
});

describe("evaluateCodexMossFirstActivityTick", () => {
  const startedAt = Date.parse("2026-09-07T00:00:00.000Z");

  it("continues before the first-activity deadline", () => {
    expect(
      evaluateCodexMossFirstActivityTick({
        firstActivityStartedAt: startedAt,
        now: startedAt + CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS - 1,
        isTurnActive: true,
        isAwaitingHuman: false,
      }),
    ).toBe("continue");
  });

  it("aborts once the Moss first-activity deadline elapses", () => {
    expect(
      evaluateCodexMossFirstActivityTick({
        firstActivityStartedAt: startedAt,
        now: startedAt + CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS,
        isTurnActive: true,
        isAwaitingHuman: false,
      }),
    ).toBe("abort");
  });

  it("disarms when the turn is no longer active", () => {
    expect(
      evaluateCodexMossFirstActivityTick({
        firstActivityStartedAt: startedAt,
        now: startedAt + CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS,
        isTurnActive: false,
        isAwaitingHuman: false,
      }),
    ).toBe("disarm");
  });

  it("touches the clock while awaiting human input", () => {
    expect(
      evaluateCodexMossFirstActivityTick({
        firstActivityStartedAt: startedAt,
        now: startedAt + CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS,
        isTurnActive: true,
        isAwaitingHuman: true,
      }),
    ).toBe("touch");
  });

  it("continues when first-activity tracking is not armed", () => {
    expect(
      evaluateCodexMossFirstActivityTick({
        firstActivityStartedAt: null,
        now: startedAt + CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS,
        isTurnActive: true,
        isAwaitingHuman: false,
      }),
    ).toBe("continue");
  });
});

describe("isCodexMossFirstActivityProgressEvent", () => {
  const base = {
    eventId: EventId.makeUnsafe("evt-watchdog"),
    provider: "codex" as const,
    threadId: ThreadId.makeUnsafe("thread-watchdog"),
    turnId: TurnId.makeUnsafe("turn-watchdog"),
    createdAt: "2026-09-07T00:00:00.000Z",
  };

  it("allows model streams, allowlisted work items, errors, and settlement", () => {
    expect(
      isCodexMossFirstActivityProgressEvent({
        ...base,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "hello" },
      }),
    ).toBe(true);
    expect(
      isCodexMossFirstActivityProgressEvent({
        ...base,
        type: "item.started",
        payload: { itemType: "command_execution" },
      }),
    ).toBe(true);
    expect(
      isCodexMossFirstActivityProgressEvent({
        ...base,
        type: "runtime.error",
        payload: { message: "provider failed" },
      }),
    ).toBe(true);
    expect(
      isCodexMossFirstActivityProgressEvent({
        ...base,
        type: "turn.completed",
        payload: { state: "failed" },
      }),
    ).toBe(true);
  });

  it("rejects bootstrap, warnings, user messages, unknown streams, and unmapped events", () => {
    expect(
      isCodexMossFirstActivityProgressEvent({
        ...base,
        type: "session.started",
        payload: {},
      }),
    ).toBe(false);
    expect(
      isCodexMossFirstActivityProgressEvent({
        ...base,
        type: "runtime.warning",
        payload: { message: "retrying" },
      }),
    ).toBe(false);
    expect(
      isCodexMossFirstActivityProgressEvent({
        ...base,
        type: "item.completed",
        payload: { itemType: "user_message" },
      }),
    ).toBe(false);
    expect(
      isCodexMossFirstActivityProgressEvent({
        ...base,
        type: "content.delta",
        payload: { streamKind: "unknown", delta: "" },
      }),
    ).toBe(false);
    expect(
      isCodexMossFirstActivityProgressEvent({
        ...base,
        type: "event.unmapped",
        payload: { nativeType: "bootstrap" },
      }),
    ).toBe(false);
  });
});
