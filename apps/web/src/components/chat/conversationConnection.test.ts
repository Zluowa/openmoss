import { describe, expect, it } from "vitest";
import type { ThreadSession } from "../../types";
import { makeActivity } from "../../storeTestFixtures";
import { deriveWorkLogEntries } from "../../workLog";
import {
  deriveConversationConnectionStatus,
  isEstablishedConversationSession,
  readProviderConnectionActivity,
} from "./conversationConnection";

const session = (status: ThreadSession["orchestrationStatus"]): ThreadSession => ({
  provider: "codex",
  status: status === "starting" ? "connecting" : status === "stopped" ? "closed" : "ready",
  orchestrationStatus: status,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
});

describe("conversation connection discriminator", () => {
  it("recovers readiness and the current transport state from durable provider events", () => {
    const activities = ["starting", "ready", "starting"].map((state, index) =>
      makeActivity({
        id: `connection-${index}`,
        kind: "provider.session.connection",
        payload: { state, provider: "codex" },
      }),
    );
    expect(readProviderConnectionActivity(activities, "codex", "codex")).toEqual({
      isConnecting: true,
      hasEstablishedSession: true,
    });
    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });
  it("does not share readiness or connecting across provider instances", () => {
    const activities = ["ready", "starting"].map((state, index) =>
      makeActivity({
        id: `connection-${index}`,
        kind: "provider.session.connection",
        payload: { state, provider: "codex", providerInstanceId: "codex-a" },
      }),
    );
    expect(readProviderConnectionActivity(activities, "codex-b", "codex")).toEqual({
      isConnecting: false,
      hasEstablishedSession: false,
    });
  });
  it("does not mistake the optimistic starting state of an ordinary follow-up for reconnect", () => {
    expect(
      deriveConversationConnectionStatus({
        session: session("starting"),
        isStarting: true,
        isResuming: false,
        isProviderConnecting: false,
        hasEstablishedSession: true,
      }),
    ).toBeNull();
  });
  it.each(["ready", "running", "interrupted"] as const)(
    "recognizes an established provider session in %s",
    (status) => expect(isEstablishedConversationSession(session(status))).toBe(true),
  );
  it.each(["idle", "starting", "stopped", "error"] as const)(
    "does not infer prior readiness from %s",
    (status) => expect(isEstablishedConversationSession(session(status))).toBe(false),
  );
  it("keeps initial startup loading, including local preflight before session projection", () => {
    for (const current of [null, session("starting")]) {
      expect(
        deriveConversationConnectionStatus({
          session: current,
          isStarting: true,
          isResuming: false,
          isProviderConnecting: false,
          hasEstablishedSession: false,
        }),
      ).toBe("loading");
    }
  });
  it("uses real provider connecting even when a settled turn suppresses generic connecting phase", () => {
    expect(
      deriveConversationConnectionStatus({
        session: session("starting"),
        isStarting: false,
        isResuming: false,
        isProviderConnecting: true,
        hasEstablishedSession: true,
      }),
    ).toBe("reconnecting");
  });
  it("does not relabel a task resume as a provider reconnect", () => {
    for (const hasEstablishedSession of [false, true]) {
      expect(
        deriveConversationConnectionStatus({
          session: null,
          isStarting: false,
          isResuming: true,
          isProviderConnecting: false,
          hasEstablishedSession,
        }),
      ).toBe(hasEstablishedSession ? null : "loading");
    }
  });
  it.each([null, session("ready"), session("running"), session("error"), session("stopped")])(
    "does not turn queued work, approval waits, stream retry or terminal error into session reconnect",
    (current) => {
      expect(
        deriveConversationConnectionStatus({
          session: current,
          isStarting: false,
          isResuming: false,
          isProviderConnecting: false,
          hasEstablishedSession: true,
        }),
      ).toBeNull();
    },
  );
});
