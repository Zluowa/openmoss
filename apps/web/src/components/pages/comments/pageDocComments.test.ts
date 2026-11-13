import { beforeEach, describe, expect, it, vi } from "vitest";

import { toggledReactions, usePageCommentsStore } from "~/pageCommentsStore";

import {
  docCommentsKey,
  docCommentThreads,
  nextPageDocStyle,
  PAGE_DOC_STYLE_DEFAULT,
  pageDocStyleOf,
  postDocComment,
} from "./pageDocComments";

const me = { name: "我", initials: "我" };
const key = docCommentsKey("page-1");

beforeEach(() => usePageCommentsStore.setState({ commentsByPage: {} }));

describe("comments on words", () => {
  it("keeps a thread under the id the editor marked, and draws it back", () => {
    postDocComment({
      pageKey: key,
      author: me,
      event: {
        event: "comment-post",
        threadId: "cm1",
        anchor: { blockId: "b1", quote: "这几个字" },
        body: "写清楚一点",
        sendToAgent: false,
      },
      ask: null,
    });
    const comments = usePageCommentsStore.getState().commentsByPage[key]!;
    expect(docCommentThreads(comments)).toEqual([
      expect.objectContaining({
        id: "cm1",
        anchor: { blockId: "b1", quote: "这几个字" },
        resolved: false,
        messages: [expect.objectContaining({ kind: "person", body: "写清楚一点" })],
      }),
    ]);
  });

  it("asks Moss when 发送给 Moss is ticked and waits for its answer in the thread", async () => {
    const ask = vi.fn(async () => "thread-9");
    postDocComment({
      pageKey: key,
      author: me,
      event: {
        event: "comment-post",
        threadId: "cm2",
        anchor: { blockId: "b2", quote: "Q3" },
        body: "改成第四季度",
        sendToAgent: true,
      },
      ask,
    });
    expect(ask).toHaveBeenCalledWith({ body: "改成第四季度", blockId: "b2", quote: "Q3" });
    await Promise.resolve();
    await Promise.resolve();
    const [thread] = docCommentThreads(usePageCommentsStore.getState().commentsByPage[key]!);
    expect(thread!.working).toBe(true);
    expect(thread!.messages[0]).toMatchObject({ sentToAgent: true });
    expect(usePageCommentsStore.getState().commentsByPage[key]![0]!.replies[0]).toMatchObject({
      kind: "agent",
      status: "thinking",
      agentThreadId: "thread-9",
    });
  });

  it("reopens a resolved thread on a reply, and never asks without an agent", () => {
    postDocComment({
      pageKey: key,
      author: me,
      event: {
        event: "comment-post",
        threadId: "cm3",
        anchor: { blockId: "b", quote: "x" },
        body: "a",
        sendToAgent: true,
      },
      ask: null,
    });
    usePageCommentsStore.getState().setResolved(key, "cm3", true);
    postDocComment({
      pageKey: key,
      author: me,
      event: { event: "comment-reply", threadId: "cm3", body: "再看看", sendToAgent: false },
      ask: null,
    });
    const [comment] = usePageCommentsStore.getState().commentsByPage[key]!;
    expect(comment!.resolved).toBe(false);
    expect(comment!.sentToAgentAt).toBeNull();
    expect(comment!.replies.map((reply) => reply.body)).toEqual(["再看看"]);
  });

  it("toggles reactions per person and sends who reacted to the editor", () => {
    postDocComment({
      pageKey: key,
      author: me,
      event: {
        event: "comment-post",
        threadId: "cm4",
        anchor: { blockId: "b", quote: "x" },
        body: "好",
        sendToAgent: false,
      },
      ask: null,
    });
    const store = usePageCommentsStore.getState();
    store.toggleReaction(key, "cm4", "cm4", "👍", "我");
    store.toggleReaction(key, "cm4", "cm4", "👍", "Ann");
    let [thread] = docCommentThreads(usePageCommentsStore.getState().commentsByPage[key]!, "我");
    expect(thread!.messages[0]!.reactions).toEqual([
      { emoji: "👍", count: 2, mine: true, names: ["我", "Ann"] },
    ]);
    usePageCommentsStore.getState().toggleReaction(key, "cm4", "cm4", "👍", "我");
    [thread] = docCommentThreads(usePageCommentsStore.getState().commentsByPage[key]!, "我");
    expect(thread!.messages[0]!.reactions).toEqual([
      { emoji: "👍", count: 1, mine: false, names: ["Ann"] },
    ]);
    expect(toggledReactions({ "👀": ["我"] }, "👀", "我")).toEqual({});
  });
});

describe("the page's doc style", () => {
  it("merges a change, and stores nothing once it is back to the default", () => {
    expect(pageDocStyleOf({})).toEqual(PAGE_DOC_STYLE_DEFAULT);
    const wide = nextPageDocStyle(PAGE_DOC_STYLE_DEFAULT, { width: "wide" });
    expect(wide).toEqual({ width: "wide", headingFont: "sans", textFont: "sans" });
    expect(nextPageDocStyle(wide!, { lang: "ja" })).toEqual({ ...wide, lang: "ja" });
    expect(nextPageDocStyle({ ...wide!, lang: "ja" }, { lang: undefined })).toEqual(wide);
    expect(nextPageDocStyle(wide!, { width: "default" })).toBeNull();
  });
});
