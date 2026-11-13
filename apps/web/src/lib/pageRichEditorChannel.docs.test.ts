import { afterEach, describe, expect, it, vi } from "vitest";

import { PageRichEditorChannel, parsePageEditorDocEvent } from "./pageRichEditorChannel";

const nonce = "editor-session-owned-by-parent";
const document = {
  documentKey: "account:scope:page-a",
  richContent: JSON.stringify([{ type: "p", children: [{ text: "x" }] }]),
  content: "x",
  readOnly: false,
  theme: "light" as const,
};
const channels: PageRichEditorChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.dispose();
});

function harness(capabilities: string[]) {
  const send = vi.fn<(message: Record<string, unknown>) => void>();
  const channel = new PageRichEditorChannel(nonce, send, vi.fn(), vi.fn(), vi.fn());
  channels.push(channel);
  const onDoc = vi.fn();
  channel.onDocEvent = onDoc;
  let seq = 0;
  const child = (event: string, fields: Record<string, unknown> = {}) =>
    channel.receive({
      type: "moss-page-editor",
      version: 1,
      sessionNonce: nonce,
      seq: ++seq,
      event,
      ...fields,
    });
  const load = () =>
    send.mock.calls
      .map(([value]) => value)
      .filter((value) => value.action === "load")
      .at(-1)!;
  channel.setComments([]);
  channel.setDocStyle({ width: "wide", headingFont: "serif", textFont: "sans" });
  channel.load(document);
  child("ready", { capabilities });
  child("loaded", {
    documentKey: document.documentKey,
    documentSeq: load().seq,
    replyTo: load().seq,
  });
  const fields = () => ({ documentKey: document.documentKey, documentSeq: load().seq });
  return { send, channel, child, onDoc, fields };
}

const base = ["rich-content", "flush", "markdown-import"];

describe("page editor document tools", () => {
  it("sends comments and the page style to an editor that has them, once it is ready", () => {
    const h = harness([...base, "doc-comments"]);
    const actions = h.send.mock.calls.map(([value]) => value.action);
    expect(actions).toContain("set-comments");
    expect(h.send.mock.calls.find(([value]) => value.action === "set-doc-style")![0]).toMatchObject(
      { style: { width: "wide", headingFont: "serif", textFont: "sans" } },
    );
    h.channel.openFind(true);
    expect(h.send.mock.calls.at(-1)![0]).toMatchObject({ action: "open-find", replace: true });
    h.channel.openComment("c1");
    expect(h.send.mock.calls.at(-1)![0]).toMatchObject({
      action: "open-comment",
      threadId: "c1",
    });
  });

  it("stays quiet for an older editor", () => {
    const h = harness(base);
    expect(h.send.mock.calls.map(([value]) => value.action)).not.toContain("set-comments");
    h.channel.openFind(false);
    expect(h.send.mock.calls.at(-1)![0].action).not.toBe("open-find");
  });

  it("passes comment events from the current page on", () => {
    const h = harness([...base, "doc-comments"]);
    expect(
      h.child("comment-post", {
        ...h.fields(),
        threadId: "cm1abc",
        anchor: { blockId: "b1", quote: "这几个字" },
        body: "这里要改吗？",
        sendToAgent: true,
      }),
    ).toBe(true);
    expect(h.onDoc).toHaveBeenCalledWith({
      event: "comment-post",
      threadId: "cm1abc",
      anchor: { blockId: "b1", quote: "这几个字" },
      body: "这里要改吗？",
      sendToAgent: true,
    });
    expect(
      h.child("comment-resolve", {
        documentKey: "other",
        documentSeq: 1,
        threadId: "cm1abc",
        resolved: true,
      }),
    ).toBe(false);
  });

  it("refuses malformed comment events", () => {
    expect(
      parsePageEditorDocEvent({
        event: "comment-post",
        threadId: "a b",
        anchor: { blockId: "", quote: "" },
        body: "x",
        sendToAgent: false,
      }),
    ).toBeNull();
    expect(
      parsePageEditorDocEvent({
        event: "comment-reply",
        threadId: "c1",
        body: "   ",
        sendToAgent: false,
      }),
    ).toBeNull();
    expect(parsePageEditorDocEvent({ event: "comment-delete", threadId: "c1" })).toEqual({
      event: "comment-delete",
      threadId: "c1",
    });
    expect(
      parsePageEditorDocEvent({ event: "comment-resolve", threadId: "c1", resolved: "yes" }),
    ).toBeNull();
    expect(
      parsePageEditorDocEvent({
        event: "comment-react",
        threadId: "c1",
        messageId: "m1",
        emoji: "👍",
      }),
    ).toEqual({ event: "comment-react", threadId: "c1", messageId: "m1", emoji: "👍" });
    expect(
      parsePageEditorDocEvent({
        event: "comment-react",
        threadId: "c1",
        messageId: "m1",
        emoji: "💩",
      }),
    ).toBeNull();
  });
});
