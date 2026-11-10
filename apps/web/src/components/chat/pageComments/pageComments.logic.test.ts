import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../../types";
import {
  PAGE_COMMENT_CARD_WIDTH,
  pageCommentMentionsAgent,
  placePageCommentCard,
  placePageCommentPin,
  resolvePageCommentAgentReply,
  removePageCommentAgentMention,
} from "./pageComments.logic";

const pane = { width: 800, height: 600 };

describe("placePageCommentPin", () => {
  it("sits on the element's top-right corner, above it when there is room", () => {
    expect(placePageCommentPin({ x: 100, y: 200, width: 50, height: 20 }, 1, pane)).toEqual({
      left: 146,
      top: 172,
      side: "above",
    });
  });

  it("drops inside the top edge near the top of the pane, and scales with zoom", () => {
    expect(placePageCommentPin({ x: 100, y: 10, width: 50, height: 20 }, 2, pane)).toEqual({
      left: 296,
      top: 24,
      side: "below",
    });
  });

  it("hides when the element is scrolled out of the pane", () => {
    expect(placePageCommentPin({ x: 0, y: -100, width: 50, height: 20 }, 1, pane)).toBeNull();
    expect(placePageCommentPin({ x: 0, y: 900, width: 50, height: 20 }, 1, pane)).toBeNull();
  });
});

describe("placePageCommentCard", () => {
  it("opens to the right of the pin and flips left at the pane's edge", () => {
    expect(placePageCommentCard({ left: 100, top: 50 }, pane).left).toBe(140);
    expect(placePageCommentCard({ left: 700, top: 50 }, pane).left).toBe(
      700 - 8 - PAGE_COMMENT_CARD_WIDTH,
    );
  });
});

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">): ChatMessage {
  return {
    id: `m-${partial.text}` as ChatMessage["id"],
    createdAt: "2026-11-03T10:00:10.000Z",
    streaming: false,
    ...partial,
  };
}

describe("resolvePageCommentAgentReply", () => {
  const comment = { body: "Make this button green", sentToAgentAt: "2026-11-03T10:00:08.000Z" };

  it("waits while the comment has not reached the thread", () => {
    expect(resolvePageCommentAgentReply({ messages: [], latestTurn: null }, comment)).toEqual({
      status: "waiting",
    });
  });

  it("is thinking while the turn runs and done with the agent's answer after", () => {
    const messages = [
      message({ role: "user", text: "Make this button green\n\n(Comment on the page …)" }),
      message({
        role: "assistant",
        text: "Done: the button is green now.",
        createdAt: "2026-11-03T10:00:20.000Z",
      }),
    ];
    const running = {
      turnId: "t1",
      state: "running",
      requestedAt: "2026-11-03T10:00:10.000Z",
      startedAt: "2026-11-03T10:00:11.000Z",
      completedAt: null,
      assistantMessageId: null,
    } as never;
    expect(resolvePageCommentAgentReply({ messages, latestTurn: running }, comment)).toEqual({
      status: "thinking",
    });
    const completed = { ...(running as object), state: "completed" } as never;
    expect(resolvePageCommentAgentReply({ messages, latestTurn: completed }, comment)).toEqual({
      status: "done",
      text: "Done: the button is green now.",
    });
  });
});

describe("@Moss mentions", () => {
  it("finds and strips a mention", () => {
    expect(pageCommentMentionsAgent("@Moss make it bigger")).toBe(true);
    expect(pageCommentMentionsAgent("email@mossy.dev")).toBe(false);
    expect(removePageCommentAgentMention("@moss, make it bigger")).toBe("make it bigger");
    expect(removePageCommentAgentMention("hi @Moss ")).toBe("hi ");
  });
});
