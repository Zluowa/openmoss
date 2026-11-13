import { describe, expect, it } from "vitest";

import {
  GUEST_TEXT_THREAD_ID,
  guestTextThreadOf,
  newGuestTextThread,
  withGuestReply,
} from "./pageGuestTextThreads";

// A thread as the owner's Moss stores it (the web app's thread record).
const ownerThread = JSON.stringify({
  id: "cm1",
  anchor: { selector: "b1", label: "Q3", text: "Q3 launch" },
  author: { name: "我", initials: "我" },
  body: "Is Q3 firm?",
  createdAt: "2026-11-13T01:00:00.000Z",
  sentToAgentAt: "2026-11-13T01:00:00.000Z",
  replies: [
    {
      id: "r1",
      kind: "agent",
      author: { name: "我" },
      body: "",
      status: "thinking",
      createdAt: "x",
    },
    {
      id: "r2",
      kind: "agent",
      author: { name: "我" },
      body: "Yes, per the plan.",
      status: "done",
      createdAt: "y",
    },
  ],
  resolved: false,
});

describe("guest views of comments on words", () => {
  it("shows the owner's thread with Moss's finished answer, not one still being written", () => {
    expect(guestTextThreadOf(ownerThread)).toEqual({
      id: "cm1",
      anchor: { blockId: "b1", quote: "Q3 launch" },
      resolved: false,
      messages: [
        {
          id: "cm1",
          authorKind: "owner",
          authorName: "",
          body: "Is Q3 firm?",
          createdAt: "2026-11-13T01:00:00.000Z",
        },
        {
          id: "r2",
          authorKind: "agent",
          authorName: "Moss",
          body: "Yes, per the plan.",
          createdAt: "y",
        },
      ],
    });
    expect(guestTextThreadOf("not json")).toBeNull();
    expect(guestTextThreadOf(JSON.stringify({ id: "x" }))).toBeNull();
  });

  it("writes a guest's new thread in the owner's shape, and their replies into it", () => {
    const id = "g0123456789abcdef";
    expect(GUEST_TEXT_THREAD_ID.test(id)).toBe(true);
    const created = newGuestTextThread({
      id,
      pageId: "p1",
      anchor: { blockId: "b2", quote: "the budget" },
      author: { kind: "guest", name: "Ann" },
      body: "Which budget?",
      createdAt: "2026-11-13T02:00:00.000Z",
    });
    expect(JSON.parse(created)).toMatchObject({
      id,
      anchor: { selector: "b2", text: "the budget" },
      author: { name: "Ann", initials: "A", authorKind: "guest" },
      replies: [],
      resolved: false,
    });
    const replied = withGuestReply(JSON.stringify({ ...JSON.parse(created), resolved: true }), {
      id: "r9",
      author: { kind: "member", name: "Bo" },
      body: "The Q4 one.",
      createdAt: "2026-11-13T03:00:00.000Z",
    });
    const thread = guestTextThreadOf(replied!);
    expect(thread?.resolved).toBe(false);
    expect(
      thread?.messages.map((message) => [message.authorKind, message.authorName, message.body]),
    ).toEqual([
      ["guest", "Ann", "Which budget?"],
      ["member", "Bo", "The Q4 one."],
    ]);
    expect(
      withGuestReply("nope", {
        id: "r",
        author: { kind: "guest", name: "x" },
        body: "y",
        createdAt: "z",
      }),
    ).toBeNull();
  });

  it("names a sheet cell comment by its cell", () => {
    const thread = guestTextThreadOf(
      JSON.stringify({
        id: "cs1",
        anchor: { selector: "sheet1/2:1", label: "表1!B3", text: "" },
        author: { name: "Ann" },
        body: "Check this total",
        createdAt: "z",
        replies: [],
      }),
    );
    expect(thread?.anchor).toEqual({ blockId: "sheet1/2:1", quote: "表1!B3" });
  });
});
