import { PageId } from "@moss/contracts";
import { READONLY_APP_ITEM_PROTOCOL } from "@moss/shared/readonlyAppItem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuestAppPreviewFrameController } from "./guestAppPreviewFrameController";
import type { GuestAppPreviewTransport } from "./guestAppPreviewTransport";

const pageId = PageId.makeUnsafe("page-fixture");
function receipt() {
  return {
    ticket: "B".repeat(43),
    ticketExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    frameExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    source: { sourceKind: "page-item" as const, pageId, pageRevision: 2, dataRevision: 1 },
    publicMetadata: { title: "Coral", revision: 2 },
  };
}
function harness(open?: GuestAppPreviewTransport["open"]) {
  vi.useFakeTimers();
  const events = Object.assign(new EventTarget(), {
    location: { origin: "https://share.example" },
  });
  const submitted: { action: string; target: string; fields: Record<string, string> }[] = [];
  class Input {
    type = "";
    name = "";
    value = "";
  }
  class Form {
    method = "";
    action = "";
    target = "";
    enctype = "";
    hidden = false;
    elements: Input[] = [];
    removed = false;
    append(input: Input) {
      this.elements.push(input);
    }
    remove() {
      this.removed = true;
    }
    submit() {
      submitted.push({
        action: this.action,
        target: this.target,
        fields: Object.fromEntries(this.elements.map((input) => [input.name, input.value])),
      });
    }
  }
  const forms: Form[] = [];
  const doc = Object.assign(new EventTarget(), {
    createElement: (tag: string) => (tag === "form" ? new Form() : new Input()),
    body: { append: (form: Form) => forms.push(form) },
  });
  vi.stubGlobal("window", events);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLFormElement", Form);
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("crypto", {
    randomUUID: () => "12345678-1234-1234-1234-123456789012",
    getRandomValues: (bytes: Uint8Array) => bytes.fill(1),
    subtle: { digest: async () => new Uint8Array(32).buffer },
  });
  const target = {};
  const element = {
    src: "about:blank",
    name: "",
    contentWindow: target,
    removeAttribute(name: string) {
      if (name === "name") this.name = "";
    },
  };
  const onStatus = vi.fn();
  const transport = {
    config: vi.fn(),
    open: vi.fn(open ?? (async () => ({ ok: true, value: receipt() }))),
  } as GuestAppPreviewTransport & { open: ReturnType<typeof vi.fn> };
  const controller = createGuestAppPreviewFrameController({
    element: element as unknown as HTMLIFrameElement,
    shareId: "A".repeat(22),
    contentOrigin: "https://apps.example",
    request: {
      pageId,
      expectedPageRevision: 2,
      visitor: "visitor-fixture",
      key: "private-proof-fixture",
    },
    transport,
    onStatus,
  });
  const receive = (extra: { nonce?: string; origin?: string; source?: unknown } = {}) => {
    const event = new Event("message");
    Object.assign(event, {
      data: {
        protocol: READONLY_APP_ITEM_PROTOCOL,
        kind: "loaded",
        nonce: extra.nonce ?? "12345678-1234-1234-1234-123456789012",
      },
      origin: extra.origin ?? "null",
      source: extra.source ?? target,
    });
    events.dispatchEvent(event);
  };
  return {
    ...controller,
    events,
    doc,
    element,
    forms,
    submitted,
    onStatus,
    transport,
    receive,
    Form,
  };
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("one-use guest preview frame lifecycle", () => {
  it("submits only the ticket and secret and immediately scrubs the temporary form", async () => {
    const h = harness();
    await flush();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.action).toBe(
      `https://apps.example/v1/app-previews/${"A".repeat(22)}/document`,
    );
    expect(Object.keys(h.submitted[0]!.fields)).toEqual(["ticket", "frameSecret"]);
    expect(h.submitted[0]!.fields.frameSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(h.forms[0]!.removed).toBe(true);
    expect(h.forms[0]!.elements.every((input) => input.value === "")).toBe(true);
    const sent = h.transport.open.mock.calls[0]![0];
    expect(sent.key).toBe("private-proof-fixture");
    expect(sent).not.toHaveProperty("frameSecret");
    h.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("requires current source, opaque origin and nonce before ready", async () => {
    const h = harness();
    await flush();
    h.receive({ source: {} });
    h.receive({ origin: "https://apps.example" });
    h.receive({ nonce: "old" });
    expect(h.onStatus).toHaveBeenLastCalledWith("loading");
    h.receive();
    expect(h.onStatus).toHaveBeenLastCalledWith("ready");
    expect(vi.getTimerCount()).toBe(1);
    h.dispose();
    expect(h.element.src).toBe("about:blank");
    expect(h.element.name).toBe("");
  });
  it.each(["switch", "unmount"])(
    "aborts an unfinished open on %s and ignores its late reply",
    async () => {
      let resolve!: (value: Awaited<ReturnType<GuestAppPreviewTransport["open"]>>) => void;
      const h = harness(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await flush();
      h.dispose();
      expect(h.transport.open.mock.calls[0]![1].aborted).toBe(true);
      resolve({ ok: true, value: receipt() });
      await flush();
      expect(h.submitted).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("times out a pending request once without retries", async () => {
    const h = harness(() => new Promise(() => {}));
    await flush();
    vi.advanceTimersByTime(8_000);
    expect(h.onStatus).toHaveBeenLastCalledWith("timeout");
    expect(h.transport.open).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out a navigation without renewing or replaying the ticket", async () => {
    const h = harness();
    await flush();
    vi.advanceTimersByTime(8_000);
    h.receive();
    expect(h.onStatus).toHaveBeenLastCalledWith("timeout");
    expect(h.submitted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("expires a ready frame and closes it on visibility resume even before timers fire", async () => {
    const h = harness();
    await flush();
    h.receive();
    vi.setSystemTime(Date.now() + 300_001);
    h.doc.dispatchEvent(new Event("visibilitychange"));
    expect(h.onStatus).toHaveBeenLastCalledWith("expired");
    expect(h.element.name).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not accept an expired loaded event after background sleep", async () => {
    const h = harness();
    await flush();
    vi.setSystemTime(Date.now() + 300_001);
    h.receive();
    expect(h.onStatus).toHaveBeenLastCalledWith("expired");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["source", "revision", "dataRevision", "metadata", "expiry", "budget"])(
    "rejects invalid receipt %s before any navigation",
    async (kind) => {
      const h = harness(async () => {
        const value = receipt();
        if (kind === "source") value.source.pageId = PageId.makeUnsafe("other-page");
        if (kind === "revision") value.source.pageRevision = 3;
        if (kind === "dataRevision") value.source.dataRevision = 3;
        if (kind === "metadata") value.publicMetadata.revision = 3;
        if (kind === "expiry") value.ticketExpiresAt = new Date(0).toISOString();
        if (kind === "budget") value.frameExpiresAt = new Date(Date.now() + 600_000).toISOString();
        return { ok: true, value };
      });
      await flush();
      expect(h.submitted).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("scrubs fields and handles if native form submission throws", async () => {
    const h = harness();
    vi.spyOn(h.Form.prototype, "submit").mockImplementation(() => {
      throw new Error("closed");
    });
    await flush();
    expect(h.onStatus).toHaveBeenLastCalledWith("invalid");
    expect(h.forms[0]!.removed).toBe(true);
    expect(h.forms[0]!.elements.every((input) => input.value === "")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
