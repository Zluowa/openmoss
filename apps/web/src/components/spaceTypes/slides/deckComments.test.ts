import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseDeckEditorEvent } from "~/lib/deckEditorChannel";
import { usePageCommentsStore } from "~/pageCommentsStore";
import { deckCommentsKey, deckCommentThreads, postDeckComment } from "./deckComments";

const key = deckCommentsKey("page-1");
const me = { name: "主人", initials: "主" };
const comments = () => usePageCommentsStore.getState().commentsByPage[key] ?? [];

describe("deck comments", () => {
  beforeEach(() => usePageCommentsStore.setState({ commentsByPage: {} }));

  it("keeps a plain comment as a thread pinned to its element", () => {
    const ask = vi.fn();
    postDeckComment({
      pageKey: key,
      author: me,
      threadId: null,
      anchor: { slideId: "s1", elementId: "e1" },
      label: "第 1 页 › “标题”",
      body: "这里再短一点",
      sendToAgent: false,
      ask,
    });
    expect(ask).not.toHaveBeenCalled();
    const [thread] = deckCommentThreads(comments());
    expect(thread).toMatchObject({
      anchor: { slideId: "s1", elementId: "e1" },
      label: "第 1 页 › “标题”",
      resolved: false,
      working: false,
      count: 1,
    });
    expect(thread!.messages[0]).toMatchObject({
      kind: "person",
      body: "这里再短一点",
      sentToAgent: false,
    });
  });

  it("hands a comment for Moss to the agent and waits in the thread for its answer", async () => {
    const ask = vi.fn(async () => "thread-9");
    postDeckComment({
      pageKey: key,
      author: me,
      threadId: null,
      anchor: { slideId: "s2" },
      label: "第 2 页",
      body: "改成绿色",
      sendToAgent: true,
      ask,
    });
    expect(ask).toHaveBeenCalledWith("改成绿色", { slideId: "s2" });
    await Promise.resolve();
    await Promise.resolve();
    const [comment] = comments();
    const reply = comment!.replies[0]!;
    expect(reply).toMatchObject({ kind: "agent", status: "thinking", agentThreadId: "thread-9" });
    expect(reply.request?.body).toBe("改成绿色");
    expect(deckCommentThreads(comments())[0]).toMatchObject({ working: true, count: 2 });
  });

  it("reopens a resolved thread when someone replies, and marks a failed hand-off", async () => {
    postDeckComment({
      pageKey: key,
      author: me,
      threadId: null,
      anchor: { slideId: "s1" },
      label: "",
      body: "第一条",
      sendToAgent: false,
      ask: vi.fn(),
    });
    const id = comments()[0]!.id;
    usePageCommentsStore.getState().setResolved(key, id, true);
    postDeckComment({
      pageKey: key,
      author: me,
      threadId: id,
      anchor: null,
      label: "",
      body: "再改一下",
      sendToAgent: true,
      ask: async () => null,
    });
    await Promise.resolve();
    await Promise.resolve();
    const [comment] = comments();
    expect(comment!.resolved).toBe(false);
    expect(comment!.replies.map((reply) => [reply.kind, reply.status])).toEqual([
      ["person", "done"],
      ["agent", "failed"],
    ]);
  });

  it("accepts only well-formed comment events from the editor", () => {
    expect(
      parseDeckEditorEvent({
        event: "comment-post",
        anchor: { slideId: "s1", elementId: "e1" },
        label: "第 1 页",
        body: "  好  ",
        sendToAgent: true,
      }),
    ).toEqual({
      event: "comment-post",
      anchor: { slideId: "s1", elementId: "e1" },
      label: "第 1 页",
      body: "好",
      sendToAgent: true,
    });
    expect(parseDeckEditorEvent({ event: "comment-post", anchor: {}, body: "x" })).toBeNull();
    expect(
      parseDeckEditorEvent({ event: "comment-reply", threadId: "t1", body: "   " }),
    ).toBeNull();
    expect(parseDeckEditorEvent({ event: "comment-resolve", threadId: "t1" })).toEqual({
      event: "comment-resolve",
      threadId: "t1",
      resolved: true,
    });
  });
});
