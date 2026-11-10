import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePageEditorAiEvent, PageRichEditorChannel } from "./pageRichEditorChannel";

const nonce = "editor-session-owned-by-parent";
const rich = JSON.stringify([{ type: "p", children: [{ text: "x" }] }]);
const document = {
  documentKey: "account:scope:page-a",
  richContent: rich,
  content: "x",
  readOnly: false,
  theme: "light" as const,
};
const context = {
  locale: "zh-CN" as const,
  aiAvailable: true,
  agentLabel: "Codex · gpt",
  drafts: [],
  threads: {},
  refs: { pages: [], files: [], chats: [] },
};
const channels: PageRichEditorChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.dispose();
});

function harness(capabilities: string[]) {
  const send = vi.fn<(message: Record<string, unknown>) => void>();
  const channel = new PageRichEditorChannel(nonce, send, vi.fn(), vi.fn(), vi.fn());
  channels.push(channel);
  const onAi = vi.fn();
  channel.onAiEvent = onAi;
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
  channel.setAiContext(context);
  channel.load(document);
  child("ready", { capabilities });
  child("loaded", {
    documentKey: document.documentKey,
    documentSeq: load().seq,
    replyTo: load().seq,
  });
  const fields = () => ({ documentKey: document.documentKey, documentSeq: load().seq });
  return { send, channel, child, onAi, fields };
}

describe("page editor AI events", () => {
  it("sends the AI context to an editor that supports drafts, before the page loads", () => {
    const h = harness(["rich-content", "flush", "markdown-import", "ai-drafts"]);
    const actions = h.send.mock.calls.map(([value]) => value.action);
    expect(actions.indexOf("set-ai-context")).toBeLessThan(actions.lastIndexOf("load"));
    h.channel.resolveDrafts("all", "accept");
    expect(h.send.mock.calls.at(-1)![0]).toMatchObject({
      action: "resolve-drafts",
      draftIds: "all",
      resolution: "accept",
    });
    expect(
      h.child("ai-request", {
        ...h.fields(),
        mode: "generate",
        prompt: "写一段介绍",
        anchorBlockId: null,
      }),
    ).toBe(true);
    expect(h.onAi).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai-request", prompt: "写一段介绍" }),
    );
  });

  it("ignores AI traffic from an editor that never offered it, and events for another document", () => {
    const legacy = harness(["rich-content", "flush", "markdown-import"]);
    expect(legacy.send.mock.calls.some(([value]) => value.action === "set-ai-context")).toBe(false);
    legacy.channel.openAiInput("generate");
    expect(legacy.send.mock.calls.at(-1)![0].action).not.toBe("open-ai-input");
    expect(legacy.child("request-subpage", legacy.fields())).toBe(false);
    const h = harness(["rich-content", "flush", "markdown-import", "ai-drafts"]);
    expect(h.child("request-subpage", { ...h.fields(), documentKey: "other" })).toBe(false);
    expect(h.onAi).not.toHaveBeenCalled();
  });

  it("validates every field the host would act on", () => {
    expect(
      parsePageEditorAiEvent({
        event: "ai-request",
        mode: "shell",
        prompt: "x",
        anchorBlockId: null,
      }),
    ).toBeNull();
    expect(
      parsePageEditorAiEvent({
        event: "ai-request",
        mode: "generate",
        prompt: "  ",
        anchorBlockId: null,
      }),
    ).toBeNull();
    expect(
      parsePageEditorAiEvent({ event: "drafts-resolved", draftIds: [], action: "accept" }),
    ).toBeNull();
    expect(
      parsePageEditorAiEvent({ event: "open-ref", kind: "url", id: "https://evil.example" }),
    ).toBeNull();
    expect(parsePageEditorAiEvent({ event: "open-ref", kind: "thread", id: "t1" })).toEqual({
      event: "open-ref",
      kind: "thread",
      id: "t1",
    });
  });
});
