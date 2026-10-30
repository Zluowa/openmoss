import type { GuestStreamEvent, OrchestrationEvent } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { deriveAgentActivityTimelineState } from "~/components/chat/agentActivity.logic";
import { deriveTimelineEntries, deriveWorkLogEntries } from "~/session-logic";
import { useStore } from "~/store";
import { initialState } from "~/storeState";
import { getThreadFromState } from "~/threadDerivation";

import {
  FIXTURE_SNAPSHOT_SEQUENCE,
  FIXTURE_THREAD_ID,
  guestFixture,
  guestThreadEvent,
  streamingReplyEvent,
  type GuestFixture,
} from "./dev/fixtures";
import {
  applyGuestStreamEvent,
  expiryRemaining,
  initialGuestStreamState,
  isGuestAttributedMessage,
  resolveGuestLocale,
  unplacedGuestMessages,
  type GuestStreamState,
} from "./guestStream.logic";

const fixture = (): GuestFixture =>
  guestFixture({ locale: "en", shareId: "share-1", guestName: "Sam", phase: "running" });

const snapshotEvent = (data: GuestFixture): GuestStreamEvent => ({
  type: "thread",
  item: { kind: "snapshot", snapshot: data.snapshot },
});

const eventFrame = (event: OrchestrationEvent): GuestStreamEvent => ({
  type: "thread",
  item: { kind: "event", event },
});

const apply = (events: ReadonlyArray<GuestStreamEvent>, state = initialGuestStreamState) =>
  events.reduce<GuestStreamState>(
    (current, event) => applyGuestStreamEvent(current, event, useStore.getState()),
    state,
  );

const thread = () => getThreadFromState(useStore.getState(), FIXTURE_THREAD_ID);

describe("applyGuestStreamEvent", () => {
  beforeEach(() => {
    // A fresh store per test; a deletion tombstone would make the sync drop the thread.
    useStore.setState({ ...initialState });
  });

  it("puts the snapshot into the app store and reads the view and truncation from the frames", () => {
    const data = fixture();
    const state = apply([
      { type: "hello", protocolVersion: 1 },
      { type: "view", view: data.view },
      snapshotEvent(data),
    ]);
    expect(state.protocolVersion).toBe(1);
    expect(state.view?.guestName).toBe("Sam");
    expect(state.threadId).toBe(FIXTURE_THREAD_ID);
    expect(state.truncated).toBe(true);
    expect(state.ended).toBeNull();
    const stored = thread();
    expect(stored?.title).toBe(data.snapshot.thread.title);
    expect(stored?.messages.map((message) => message.id)).toEqual(
      data.snapshot.thread.messages.map((message) => message.id),
    );
    // The guest routes have no history pagination, so the store must not offer to load older rows.
    expect(useStore.getState().threadHistoryById?.[FIXTURE_THREAD_ID]).toBeUndefined();
  });

  it("applies later events through the owner's reducer, and ignores events before a snapshot", () => {
    const data = fixture();
    const early = apply([eventFrame(streamingReplyEvent(data, "Too early", true, 1))]);
    expect(early.threadId).toBeNull();
    expect(thread()).toBeUndefined();

    const state = apply(
      [
        snapshotEvent(data),
        eventFrame(streamingReplyEvent(data, "All 12", true, FIXTURE_SNAPSHOT_SEQUENCE + 1)),
        eventFrame(
          streamingReplyEvent(data, "All 12 tests pass.", false, FIXTURE_SNAPSHOT_SEQUENCE + 2),
        ),
        {
          type: "thread",
          item: {
            kind: "replay",
            events: [
              guestThreadEvent(
                "thread.activity-appended",
                {
                  threadId: FIXTURE_THREAD_ID,
                  activity: {
                    ...data.snapshot.thread.activities[0]!,
                    id: "replayed-activity" as never,
                    summary: "git push",
                    createdAt: new Date().toISOString(),
                  },
                },
                FIXTURE_SNAPSHOT_SEQUENCE + 3,
              ),
            ],
          },
        },
      ],
      early,
    );
    expect(state.threadId).toBe(FIXTURE_THREAD_ID);
    const stored = thread()!;
    const reply = stored.messages.find((message) => message.id === data.streaming.messageId)!;
    expect(reply.text).toBe("All 12 tests pass.");
    expect(reply.streaming).toBe(false);
    expect(stored.activities.some((activity) => activity.summary === "git push")).toBe(true);
  });

  it("produces the owner's timeline rows from the shared derive functions", () => {
    const data = fixture();
    apply([snapshotEvent(data)]);
    const stored = thread()!;
    const workEntries = deriveWorkLogEntries(stored.activities, stored.latestTurn?.turnId, {
      visibleTurnIds: new Set(
        stored.messages.flatMap((message) => (message.turnId ? [message.turnId] : [])),
      ),
      activeTurnId: stored.latestTurn?.turnId ?? null,
      activeTurnStartedAt: stored.latestTurn?.startedAt ?? null,
      latestTurnState: stored.latestTurn?.state ?? null,
      latestTurnCompletedAt: stored.latestTurn?.completedAt ?? null,
    });
    const { timelineWorkEntries } = deriveAgentActivityTimelineState(workEntries);
    const entries = deriveTimelineEntries(
      stored.messages,
      stored.proposedPlans,
      timelineWorkEntries,
    );
    const kinds = entries.map((entry) =>
      entry.kind === "message" ? `${entry.kind}:${entry.message.role}` : entry.kind,
    );
    // Messages keep their order, the plan gets its own row, and tool work sits between them.
    expect(kinds.filter((kind) => kind.startsWith("message"))).toEqual([
      "message:user",
      "message:assistant",
      "message:user",
      "message:assistant",
      "message:user",
      "message:assistant",
    ]);
    expect(kinds).toContain("proposed-plan");
    expect(kinds.filter((kind) => kind === "work").length).toBeGreaterThan(0);
    const firstUser = kinds.indexOf("message:user");
    const firstWork = kinds.indexOf("work");
    expect(firstWork).toBeGreaterThan(firstUser);
  });

  it("ends when the view names another share, and records the end reason", () => {
    const data = fixture();
    const state = apply([
      { type: "view", view: data.view },
      { type: "view", view: { ...data.view, shareId: "share-2" as never } },
    ]);
    expect(state.ended).toBe("replaced");
    expect(state.view?.shareId).toBe(data.view.shareId);
    expect(apply([{ type: "ended", reason: "expired" }]).ended).toBe("expired");
  });
});

const T = (second: number) => `2026-10-29T10:00:${String(second).padStart(2, "0")}.000Z`;
const row = (text: string, createdAt: string) => ({ role: "user" as const, text, createdAt });

const own = (id: string, status: "pending" | "sent" | "dismissed", submittedAt: string) => ({
  id: id as never,
  text: id,
  status,
  submittedAt,
  attachments: [],
});

describe("unplacedGuestMessages", () => {
  it("shows waiting ones, and answered ones only if this page saw them wait", () => {
    const messages = [
      own("late", "pending", T(40)),
      own("sent-unseen", "sent", T(5)),
      own("sent-seen", "sent", T(30)),
      own("dismissed-seen", "dismissed", T(20)),
      own("dismissed-unseen", "dismissed", T(10)),
    ];
    const seen = new Set(["sent-seen", "dismissed-seen", "late"]);
    expect(unplacedGuestMessages(messages, [], "Sam", seen).map((m) => m.id)).toEqual([
      "dismissed-seen",
      "sent-seen",
      "late",
    ]);
  });

  it("drops a sent one once the thread shows this guest's message after it", () => {
    const messages = [own("sent-seen", "sent", T(30))];
    const seen = new Set(["sent-seen"]);
    const landed = [row("Message from guest Sam, sent by the owner:\n\nWhy?", T(31))];
    expect(unplacedGuestMessages(messages, landed, "Sam", seen)).toEqual([]);
    const someoneElse = [row("Message from guest Ana, sent by the owner:\n\nWhy?", T(31))];
    expect(unplacedGuestMessages(messages, someoneElse, "Sam", seen).map((m) => m.id)).toEqual([
      "sent-seen",
    ]);
    const earlier = [row("Message from guest Sam, sent by the owner:\n\nWhy?", T(29))];
    expect(unplacedGuestMessages(messages, earlier, "Sam", seen).map((m) => m.id)).toEqual([
      "sent-seen",
    ]);
    expect(
      isGuestAttributedMessage("Message from guest Sam, sent by the owner:\n\nhi", "Sam"),
    ).toBe(true);
    expect(isGuestAttributedMessage("hi", "Sam")).toBe(false);
  });
});

describe("expiryRemaining", () => {
  const now = Date.parse("2026-10-29T00:00:00.000Z");
  it("shows whole hours, then minutes, then nothing", () => {
    expect(expiryRemaining("2026-10-29T23:59:00.000Z", now)).toEqual({ unit: "hours", value: 23 });
    expect(expiryRemaining("2026-10-29T00:45:30.000Z", now)).toEqual({
      unit: "minutes",
      value: 45,
    });
    expect(expiryRemaining("2026-10-29T00:00:00.000Z", now)).toBeNull();
    expect(expiryRemaining("not a date", now)).toBeNull();
  });
});

describe("resolveGuestLocale", () => {
  it("picks Chinese for any zh tag and English otherwise", () => {
    expect(resolveGuestLocale(["zh-CN"])).toBe("zh-CN");
    expect(resolveGuestLocale(["zh-Hans-CN", "en"])).toBe("zh-CN");
    expect(resolveGuestLocale(["ZH-TW"])).toBe("zh-CN");
    expect(resolveGuestLocale(["en-US", "zh-CN"])).toBe("en");
    expect(resolveGuestLocale(["fr-FR"])).toBe("en");
    expect(resolveGuestLocale(["", "zh"])).toBe("zh-CN");
    expect(resolveGuestLocale([])).toBe("en");
  });
});
