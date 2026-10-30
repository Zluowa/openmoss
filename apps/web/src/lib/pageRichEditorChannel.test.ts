import { afterEach, describe, expect, it, vi } from "vitest";

import { PAGE_RICH_CONTENT_LIMITS } from "@synara/shared/pageRichContent";
import { PageRichEditorChannel, type PageRichEditorDocument } from "./pageRichEditorChannel";

const nonce = "editor-session-owned-by-parent";
const capabilities = ["rich-content", "flush", "markdown-import"];
const rich = (text: string) => JSON.stringify([{ type: "p", children: [{ text }] }]);
const document: PageRichEditorDocument = {
  documentKey: "account:scope:page-a",
  richContent: rich("Original draft"),
  content: "Original draft",
  readOnly: false,
  theme: "light",
};
const channels: PageRichEditorChannel[] = [];
type Packet = Record<string, unknown>;

function harness() {
  const send = vi.fn<(message: Packet) => void>();
  const onChange = vi.fn();
  const onReady = vi.fn();
  const onError = vi.fn();
  const onUnavailable = vi.fn();
  const channel = new PageRichEditorChannel(nonce, send, onChange, onReady, onError, onUnavailable);
  channels.push(channel);
  let childSeq = 0;
  const packet = (seq: number, event: string, fields: Packet = {}) => ({
    type: "moss-page-editor",
    version: 1,
    sessionNonce: nonce,
    seq,
    event,
    ...fields,
  });
  const child = (event: string, fields: Packet = {}) =>
    channel.receive(packet(++childSeq, event, fields));
  const lastSent = () => send.mock.calls.at(-1)![0];
  const currentFields = () => ({
    documentKey: lastLoad().documentKey,
    documentSeq: lastLoad().seq,
  });
  const lastLoad = () =>
    send.mock.calls
      .map(([value]) => value)
      .filter((value) => value.action === "load")
      .at(-1)!;
  const prepare = (value: PageRichEditorDocument = document) => {
    channel.load(value);
    expect(child("ready", { capabilities })).toBe(true);
    return lastLoad();
  };
  const acknowledgeLoad = () => child("loaded", { ...currentFields(), replyTo: lastLoad().seq });
  const activate = (value: PageRichEditorDocument = document) => {
    prepare(value);
    expect(acknowledgeLoad()).toBe(true);
  };
  return {
    channel,
    send,
    onChange,
    onReady,
    onError,
    onUnavailable,
    packet,
    child,
    lastSent,
    lastLoad,
    currentFields,
    prepare,
    acknowledgeLoad,
    activate,
  };
}

afterEach(() => {
  for (const channel of channels.splice(0)) channel.dispose();
  vi.useRealTimers();
});

describe("parent-owned Plate editor channel", () => {
  it("ignores an uncorrelated malformed flush without contaminating the current save", async () => {
    const h = harness();
    h.activate();
    const result = h.channel.flush();
    const request = h.lastSent().seq;
    expect(
      h.child("flushed", {
        ...h.currentFields(),
        replyTo: Number(request) + 100,
        richContent: "malformed unrelated response",
      }),
    ).toBe(false);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onChange).not.toHaveBeenCalled();
    expect(
      h.child("flushed", {
        ...h.currentFields(),
        replyTo: request,
        richContent: rich("Current save"),
      }),
    ).toBe(true);
    await expect(result).resolves.toBe(true);
  });

  it("preserves a legacy Markdown document when the live editor has not changed", async () => {
    const h = harness();
    h.activate({ ...document, richContent: null, content: "# Original" });
    const result = h.channel.flush();
    expect(
      h.child("flushed", {
        ...h.currentFields(),
        replyTo: h.lastSent().seq,
        richContent: JSON.stringify([{ type: "h1", children: [{ text: "Original" }] }]),
        unchanged: true,
      }),
    ).toBe(true);
    await expect(result).resolves.toBe(true);
    expect(h.onChange).toHaveBeenCalledExactlyOnceWith({
      content: "# Original",
      richContent: null,
    });
  });

  it("restores the original document format when rich editing is undone to its loaded state", () => {
    const h = harness();
    h.activate({ ...document, richContent: null, content: "Original" });
    expect(
      h.child("change", { ...h.currentFields(), richContent: rich("Edited"), unchanged: false }),
    ).toBe(true);
    expect(h.onChange).toHaveBeenLastCalledWith({ content: "Edited", richContent: rich("Edited") });
    expect(
      h.child("change", { ...h.currentFields(), richContent: rich("Original"), unchanged: true }),
    ).toBe(true);
    expect(h.onChange).toHaveBeenLastCalledWith({ content: "Original", richContent: null });
  });

  it("preserves exact loaded rich JSON on an unchanged flush", async () => {
    const h = harness();
    const original = JSON.stringify(
      [{ type: "p", children: [{ text: "Original draft" }] }],
      null,
      2,
    );
    h.activate({ ...document, richContent: original });
    const result = h.channel.flush();
    expect(
      h.child("flushed", {
        ...h.currentFields(),
        replyTo: h.lastSent().seq,
        richContent: rich("Original draft"),
        unchanged: true,
      }),
    ).toBe(true);
    await expect(result).resolves.toBe(true);
    expect(h.onChange).toHaveBeenLastCalledWith({
      content: document.content,
      richContent: original,
    });
  });

  it("ignores errors from an old document and unknown request identities", () => {
    const h = harness();
    h.activate();
    const old = h.currentFields();
    h.channel.load({ ...document, documentKey: "account:scope:page-b" });
    expect(
      h.channel.receive(
        h.packet(1000, "error", { ...old, replyTo: old.documentSeq, message: "Old load failed" }),
      ),
    ).toBe(false);
    expect(
      h.child("error", {
        ...h.currentFields(),
        replyTo: Number(h.lastLoad().seq) + 100,
        message: "Unknown request",
      }),
    ).toBe(false);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.acknowledgeLoad()).toBe(true);
    expect(h.child("change", { ...h.currentFields(), richContent: rich("Current draft") })).toBe(
      true,
    );
    expect(h.onChange).toHaveBeenLastCalledWith({
      content: "Current draft",
      richContent: rich("Current draft"),
    });
  });

  it("keeps ready separate from a correlated loaded acknowledgement", async () => {
    const h = harness();
    h.channel.hello();
    expect(h.lastSent()).toMatchObject({
      type: "moss-page-editor",
      version: 1,
      sessionNonce: nonce,
      action: "hello",
      seq: 1,
    });
    h.prepare();
    expect(h.onReady).not.toHaveBeenCalledWith(true);
    await expect(h.channel.flush()).resolves.toBe(false);
    expect(h.child("change", { ...h.currentFields(), richContent: rich("Too early") })).toBe(false);
    expect(h.child("loaded", { ...h.currentFields(), replyTo: Number(h.lastLoad().seq) + 1 })).toBe(
      false,
    );
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.acknowledgeLoad()).toBe(true);
    expect(h.onReady).toHaveBeenLastCalledWith(true);
  });

  it("requires the capabilities needed to import Markdown and safely flush rich content", () => {
    const h = harness();
    h.channel.load(document);
    for (const missing of capabilities) {
      expect(
        h.child("ready", {
          capabilities: capabilities.filter((capability) => capability !== missing),
        }),
      ).toBe(false);
    }
    expect(h.send).not.toHaveBeenCalled();
    expect(h.onReady).not.toHaveBeenCalledWith(true);
    expect(h.onError).toHaveBeenCalledTimes(3);
  });

  it("rejects wrong envelopes, nonces and stale or invalid sequence numbers without poisoning the valid sequence", () => {
    const h = harness();
    h.activate();
    const body = { ...h.currentFields(), richContent: rich("Valid buffer") };
    for (const invalid of [
      { type: "another-channel" },
      { version: 2 },
      { sessionNonce: "another-session" },
      { seq: 0 },
      { seq: -1 },
      { seq: 1.5 },
      { seq: Number.NaN },
      { seq: Number.POSITIVE_INFINITY },
    ])
      expect(h.channel.receive(h.packet(1000, "change", { ...body, ...invalid }))).toBe(false);
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.child("change", body)).toBe(true);
    expect(
      h.channel.receive(
        h.packet(3, "change", { ...body, richContent: rich("Replayed older buffer") }),
      ),
    ).toBe(false);
    expect(h.onChange).toHaveBeenCalledExactlyOnceWith({
      content: "Valid buffer",
      richContent: rich("Valid buffer"),
    });
  });

  it("rejects a stale document and requires a fresh loaded handshake after document switching", () => {
    const h = harness();
    h.activate();
    const old = h.currentFields();
    h.channel.load({ ...document, documentKey: "account:scope:page-b", richContent: rich("B") });
    expect(h.onReady).toHaveBeenLastCalledWith(false);
    expect(h.child("change", { ...old, richContent: rich("Stale A") })).toBe(false);
    expect(h.child("loaded", { ...old, replyTo: old.documentSeq })).toBe(false);
    expect(h.child("change", { ...h.currentFields(), richContent: rich("B before loaded") })).toBe(
      false,
    );
    expect(h.acknowledgeLoad()).toBe(true);
    expect(h.child("change", { ...h.currentFields(), richContent: rich("Current B") })).toBe(true);
    expect(h.onChange).toHaveBeenCalledExactlyOnceWith({
      content: "Current B",
      richContent: rich("Current B"),
    });
  });

  it("closes the loaded gate when a child reannounces readiness", async () => {
    const h = harness();
    h.activate();
    const previousLoad = h.lastLoad().seq;
    expect(h.child("ready", { capabilities })).toBe(true);
    expect(h.lastLoad().seq).not.toBe(previousLoad);
    expect(h.onReady).toHaveBeenLastCalledWith(false);
    await expect(h.channel.flush()).resolves.toBe(false);
    expect(
      h.child("change", { ...h.currentFields(), richContent: rich("Unacknowledged reload") }),
    ).toBe(false);
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.acknowledgeLoad()).toBe(true);
  });

  it("derives the readable projection from actual rich JSON instead of accepting child-supplied text", () => {
    const h = harness();
    h.activate();
    const richContent = JSON.stringify([
      { type: "h2", children: [{ text: "Actual document", bold: true }] },
    ]);
    expect(
      h.child("change", { ...h.currentFields(), richContent, content: "Forged unrelated content" }),
    ).toBe(true);
    expect(h.onChange).toHaveBeenLastCalledWith({ richContent, content: "## **Actual document**" });
  });

  it("changes presentation without reloading the document or replacing its unsaved buffer", async () => {
    const h = harness();
    h.activate();
    const fields = h.currentFields();
    h.child("change", { ...fields, richContent: rich("Unsaved real edit") });
    const loadCount = h.send.mock.calls.filter(([message]) => message.action === "load").length;
    h.channel.setPresentation({ theme: "dark", fontSize: 18 });
    expect(h.lastSent()).toMatchObject({ action: "set-presentation", theme: "dark", fontSize: 18 });
    expect(h.send.mock.calls.filter(([message]) => message.action === "load")).toHaveLength(
      loadCount,
    );
    expect(h.currentFields()).toEqual(fields);
    expect(h.onReady).toHaveBeenLastCalledWith(true);
    const flushed = h.channel.flush();
    expect(
      h.child("flushed", {
        ...fields,
        replyTo: h.lastSent().seq,
        richContent: rich("Unsaved real edit"),
      }),
    ).toBe(true);
    await expect(flushed).resolves.toBe(true);
    expect(h.onChange).toHaveBeenLastCalledWith({
      content: "Unsaved real edit",
      richContent: rich("Unsaved real edit"),
    });
  });

  it("preserves an empty rich document and refuses unsafe or temporary URL snapshots before they replace a draft", () => {
    const h = harness();
    h.activate();
    expect(h.child("change", { ...h.currentFields(), richContent: "[]" })).toBe(true);
    expect(h.onChange).toHaveBeenCalledExactlyOnceWith({ content: "", richContent: "[]" });
    for (const [type, url] of [
      ["a", "javascript:active()"],
      ["img", "blob:https://example.test/transient"],
    ]) {
      expect(
        h.child("change", {
          ...h.currentFields(),
          richContent: JSON.stringify([{ type, url, children: [] }]),
        }),
      ).toBe(false);
    }
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledTimes(2);
  });

  it("preserves the last good buffer when malformed, unsafe or over-limit rich JSON arrives", () => {
    const h = harness();
    h.activate();
    expect(h.child("change", { ...h.currentFields(), richContent: rich("Keep this draft") })).toBe(
      true,
    );
    for (const richContent of [
      "not-json",
      "{}",
      '[{"type":"p","children":[],"__proto__":{}}]',
      JSON.stringify([{ text: "x".repeat(PAGE_RICH_CONTENT_LIMITS.bytes) }]),
    ]) {
      expect(h.child("change", { ...h.currentFields(), richContent })).toBe(false);
    }
    expect(h.onChange).toHaveBeenCalledExactlyOnceWith({
      richContent: rich("Keep this draft"),
      content: "Keep this draft",
    });
    expect(h.onError).toHaveBeenCalledTimes(4);
  });

  it("samples flushed rich JSON so the final edit is saved before its 350ms change notification", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.activate();
    h.child("change", { ...h.currentFields(), richContent: rich("Earlier notification") });
    const finalRich = rich("The final Plate edit before leaving");
    const debounced = setTimeout(
      () => h.child("change", { ...h.currentFields(), richContent: finalRich }),
      350,
    );
    const flushed = h.channel.flush();
    const request = h.lastSent();
    expect(request.action).toBe("flush");
    expect(
      h.child("flushed", {
        ...h.currentFields(),
        replyTo: request.seq,
        richContent: finalRich,
        content: "Stale child projection",
      }),
    ).toBe(true);
    await expect(flushed).resolves.toBe(true);
    expect(h.onChange).toHaveBeenLastCalledWith({
      richContent: finalRich,
      content: "The final Plate edit before leaving",
    });
    // A real host cancels its pending notification when sampling flush. The
    // parent already received the real final JSON before the debounce elapsed.
    clearTimeout(debounced);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat a wrong acknowledgement as success or let it replace the draft", async () => {
    const h = harness();
    h.activate();
    const result = h.channel.flush();
    const request = h.lastSent();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    expect(
      h.child("flushed", {
        ...h.currentFields(),
        replyTo: Number(request.seq) + 1,
        richContent: rich("Wrong acknowledgement"),
      }),
    ).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.onChange).not.toHaveBeenCalled();
    expect(
      h.child("flushed", {
        ...h.currentFields(),
        replyTo: request.seq,
        richContent: rich("Acknowledged final buffer"),
      }),
    ).toBe(true);
    await expect(result).resolves.toBe(true);
  });

  it("fails an invalid flush payload without changing the previously observed draft", async () => {
    const h = harness();
    h.activate();
    h.child("change", { ...h.currentFields(), richContent: rich("Preserved") });
    const result = h.channel.flush();
    expect(
      h.child("flushed", { ...h.currentFields(), replyTo: h.lastSent().seq, richContent: "[1]" }),
    ).toBe(false);
    await expect(result).resolves.toBe(false);
    expect(h.onChange).toHaveBeenCalledExactlyOnceWith({
      richContent: rich("Preserved"),
      content: "Preserved",
    });
  });

  it("retains the draft on a correlated child error and on the unchanged flush timeout", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.activate();
    h.child("change", { ...h.currentFields(), richContent: rich("Do not lose this") });
    const errored = h.channel.flush();
    expect(
      h.child("error", {
        ...h.currentFields(),
        replyTo: h.lastSent().seq,
        message: "Plate could not serialize",
      }),
    ).toBe(true);
    await expect(errored).resolves.toBe(false);
    const timedOut = h.channel.flush();
    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void timedOut.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(timedOut).resolves.toBe(false);
    expect(h.onChange).toHaveBeenCalledExactlyOnceWith({
      richContent: rich("Do not lose this"),
      content: "Do not lose this",
    });
    expect(h.onError).toHaveBeenCalledWith("Plate could not serialize");
    expect(h.onError).toHaveBeenLastCalledWith(expect.stringContaining("最新内容"));
  });

  it("resolves every pending flush as false on reset and rejects old replies", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.activate();
    const first = h.channel.flush();
    const oldReply = h.lastSent().seq;
    const second = h.channel.flush();
    h.channel.reset();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(h.onReady).toHaveBeenLastCalledWith(false);
    expect(
      h.child("flushed", {
        documentKey: document.documentKey,
        documentSeq: 1,
        replyTo: oldReply,
        richContent: rich("Old buffer"),
      }),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onChange).not.toHaveBeenCalled();
  });

  it("keeps read-only content immutable and never reopens a disposed channel", async () => {
    const h = harness();
    h.activate({ ...document, readOnly: true });
    expect(h.child("change", { ...h.currentFields(), richContent: rich("Unexpected edit") })).toBe(
      true,
    );
    expect(h.onChange).not.toHaveBeenCalled();
    h.channel.dispose();
    expect(h.child("ready", { capabilities })).toBe(false);
    await expect(h.channel.flush()).resolves.toBe(false);
  });

  it("updates presentation without reloading the document or invalidating its live flush", async () => {
    const h = harness();
    h.activate();
    const loaded = h.lastLoad();
    const result = h.channel.flush();
    const flushSeq = h.lastSent().seq;
    h.channel.setPresentation({ theme: "dark", fontSize: 18 });
    expect(h.lastSent()).toMatchObject({ action: "set-presentation", theme: "dark", fontSize: 18 });
    expect(h.lastLoad()).toBe(loaded);
    expect(h.onReady).toHaveBeenLastCalledWith(true);
    expect(
      h.child("flushed", {
        ...h.currentFields(),
        replyTo: flushSeq,
        richContent: rich("Uninterrupted draft"),
      }),
    ).toBe(true);
    await expect(result).resolves.toBe(true);
    expect(h.onChange).toHaveBeenLastCalledWith({
      content: "Uninterrupted draft",
      richContent: rich("Uninterrupted draft"),
    });
  });

  it("retains presentation updates made before the child is ready", () => {
    const h = harness();
    h.channel.load(document);
    h.channel.setPresentation({ theme: "dark", fontSize: 20 });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.child("ready", { capabilities })).toBe(true);
    expect(h.lastLoad()).toMatchObject({ ...document, theme: "dark", fontSize: 20 });
  });

  it("marks unavailable only for a strictly correlated current load failure while keeping flush unsuccessful", async () => {
    const h = harness();
    h.channel.load(document);
    h.child("error", {
      documentKey: document.documentKey,
      documentSeq: 0,
      replyTo: 0,
      message: "No handshake",
    });
    expect(h.onUnavailable).not.toHaveBeenCalledWith(true);
    h.prepare();
    const fields = h.currentFields();
    for (const extra of [
      { documentKey: "another-page" },
      { documentSeq: Number(fields.documentSeq) + 1 },
      { replyTo: Number(fields.documentSeq) + 1 },
    ]) {
      h.child("error", {
        ...fields,
        replyTo: fields.documentSeq,
        message: "Unrelated error",
        ...extra,
      });
    }
    expect(h.onUnavailable).not.toHaveBeenCalledWith(true);
    expect(
      h.child("error", {
        ...fields,
        replyTo: fields.documentSeq,
        message: "Unsupported saved node",
      }),
    ).toBe(true);
    expect(h.onUnavailable).toHaveBeenLastCalledWith(true);
    await expect(h.channel.flush()).resolves.toBe(false);
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.onReady).not.toHaveBeenCalledWith(true);
  });

  it("clears unavailable on new loads, valid readiness, reset and a successful loaded acknowledgement", () => {
    const h = harness();
    h.prepare();
    const failLoad = () =>
      h.child("error", {
        ...h.currentFields(),
        replyTo: h.lastLoad().seq,
        message: "Cannot load saved structure",
      });
    failLoad();
    expect(h.onUnavailable).toHaveBeenLastCalledWith(true);
    h.channel.load({ ...document, documentKey: "page-b" });
    expect(h.onUnavailable).toHaveBeenLastCalledWith(false);
    failLoad();
    expect(h.onUnavailable).toHaveBeenLastCalledWith(true);
    h.child("ready", { capabilities });
    expect(h.onUnavailable).toHaveBeenLastCalledWith(false);
    failLoad();
    expect(h.onUnavailable).toHaveBeenLastCalledWith(true);
    expect(h.acknowledgeLoad()).toBe(true);
    expect(h.onUnavailable).toHaveBeenLastCalledWith(false);
    h.channel.load(document);
    failLoad();
    expect(h.onUnavailable).toHaveBeenLastCalledWith(true);
    h.channel.reset();
    expect(h.onUnavailable).toHaveBeenLastCalledWith(false);
  });

  it("never labels a loaded editor unavailable because of an error or a stale document response", () => {
    const h = harness();
    h.activate();
    const old = h.currentFields();
    h.child("error", {
      ...old,
      replyTo: old.documentSeq,
      message: "Runtime error in an already loaded document",
    });
    expect(h.onUnavailable).not.toHaveBeenCalledWith(true);
    h.channel.load({ ...document, documentKey: "new-current-page" });
    h.child("error", {
      ...old,
      replyTo: old.documentSeq,
      message: "Late error from previous page",
    });
    expect(h.onUnavailable).not.toHaveBeenCalledWith(true);
    expect(h.onChange).not.toHaveBeenCalled();
  });
});
