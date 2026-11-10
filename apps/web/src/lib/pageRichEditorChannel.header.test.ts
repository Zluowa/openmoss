import { describe, expect, it, vi } from "vitest";

import {
  PageRichEditorChannel,
  type PageRichEditorDocument,
  type PageRichEditorHeader,
} from "./pageRichEditorChannel";

const nonce = "editor-session-owned-by-parent";
const document: PageRichEditorDocument = {
  documentKey: "account:scope:page-a",
  richContent: JSON.stringify([{ type: "p", children: [{ text: "Body" }] }]),
  content: "Body",
  readOnly: false,
  theme: "light",
};
const header: PageRichEditorHeader = {
  title: "Changelog",
  placeholder: "未命名页面",
  editable: true,
  crumbs: [{ id: "page:parent", label: "Parent" }],
  links: [],
  icon: "book",
  cover: null,
};

function harness(capabilities: string[]) {
  const send = vi.fn<(message: Record<string, unknown>) => void>();
  const channel = new PageRichEditorChannel(nonce, send, vi.fn(), vi.fn(), vi.fn());
  const support = vi.fn();
  const events = vi.fn();
  channel.onHeaderSupportChange = support;
  channel.onHeaderEvent = events;
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
  const sent = (action: string) =>
    send.mock.calls.map(([value]) => value).filter((value) => value.action === action);
  const load = () => sent("load").at(-1)!;
  const current = () => ({ documentKey: load().documentKey, documentSeq: load().seq });
  return { channel, support, events, child, sent, load, current };
}

describe("page header in the editor", () => {
  it("sends the header to an editor that draws it and relays its edits", () => {
    const h = harness(["rich-content", "flush", "markdown-import", "page-header"]);
    h.channel.setHeader(header);
    h.channel.load(document);
    expect(h.sent("set-header")).toHaveLength(0);
    h.child("ready", { capabilities: ["rich-content", "flush", "markdown-import", "page-header"] });
    expect(h.support).toHaveBeenCalledWith(true);
    expect(h.sent("set-header").at(-1)?.header).toEqual(header);
    h.child("loaded", { ...h.current(), replyTo: h.load().seq });
    h.channel.setHeader({ ...header, title: "Release notes" });
    expect(h.sent("set-header").at(-1)?.header).toMatchObject({ title: "Release notes" });

    expect(h.child("header-change", { ...h.current(), title: "New title" })).toBe(true);
    expect(h.child("header-change", { ...h.current(), icon: "rocket", cover: "sage" })).toBe(true);
    expect(h.child("header-action", { ...h.current(), id: "page:parent" })).toBe(true);
    expect(h.events.mock.calls.map(([event]) => event)).toEqual([
      { event: "header-change", title: "New title" },
      { event: "header-change", icon: "rocket", cover: "sage" },
      { event: "header-action", id: "page:parent" },
    ]);
  });

  it("refuses malformed or empty header edits and edits from another document", () => {
    const h = harness([]);
    h.channel.load(document);
    h.child("ready", { capabilities: ["rich-content", "flush", "markdown-import", "page-header"] });
    h.child("loaded", { ...h.current(), replyTo: h.load().seq });
    expect(h.child("header-change", { ...h.current() })).toBe(false);
    expect(h.child("header-change", { ...h.current(), cover: "neon" })).toBe(false);
    expect(h.child("header-change", { ...h.current(), icon: " book" })).toBe(false);
    expect(h.child("header-change", { ...h.current(), title: "x".repeat(257) })).toBe(false);
    expect(
      h.child("header-change", { documentKey: "other", documentSeq: h.load().seq, title: "x" }),
    ).toBe(false);
    expect(h.events).not.toHaveBeenCalled();
  });

  it("keeps drawing its own header for an editor without the capability", () => {
    const h = harness([]);
    h.channel.setHeader(header);
    h.channel.load(document);
    h.child("ready", { capabilities: ["rich-content", "flush", "markdown-import"] });
    expect(h.support).not.toHaveBeenCalled();
    expect(h.channel.headerSupported).toBe(false);
    expect(h.sent("set-header")).toHaveLength(0);
  });
});
