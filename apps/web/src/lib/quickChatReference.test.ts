import { describe, expect, it } from "vitest";

import {
  buildQuickChatReferenceContext,
  parseQuickChatReferenceContext,
} from "./quickChatReference";

describe("Quick Chat reference context", () => {
  it("round-trips a versioned stable reference and normalizes its title", () => {
    const context = buildQuickChatReferenceContext({
      conversationId: " provider-conversation-1 ",
      threadId: " moss-thread-1 ",
      title: "  Release   notes  ",
    });

    expect(context).toBe(
      '<quick_chat_reference>\n{"type":"quick-chat","version":1,"conversationId":"provider-conversation-1","threadId":"moss-thread-1","title":"Release notes"}\n</quick_chat_reference>',
    );
    expect(parseQuickChatReferenceContext(context)).toEqual({
      type: "quick-chat",
      version: 1,
      conversationId: "provider-conversation-1",
      threadId: "moss-thread-1",
      title: "Release notes",
    });
  });

  it("rejects malformed, unsupported, and empty references", () => {
    expect(parseQuickChatReferenceContext("plain pasted text")).toBeNull();
    expect(
      parseQuickChatReferenceContext(
        '<quick_chat_reference>\n{"type":"quick-chat","version":2,"conversationId":"c","threadId":"t","title":"Title"}\n</quick_chat_reference>',
      ),
    ).toBeNull();
    expect(
      parseQuickChatReferenceContext(
        '<quick_chat_reference>\n{"type":"quick-chat","version":1,"conversationId":"","threadId":"t","title":"Title"}\n</quick_chat_reference>',
      ),
    ).toBeNull();
  });
});
