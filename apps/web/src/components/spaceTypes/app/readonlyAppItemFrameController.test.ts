// FILE: readonlyAppItemFrameController.test.ts
// Purpose: Nonce, source, revision lifetime, timeout and expiry cleanup.
// Layer: Web lifecycle tests

import {
  READONLY_APP_ITEM_PROTOCOL,
  READONLY_APP_ITEM_TIMEOUT_MS,
} from "@moss/shared/readonlyAppItem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReadonlyAppItemFrameController } from "./readonlyAppItemFrameController";

function setup(expiresAt?: number) {
  vi.useFakeTimers();
  const events = new EventTarget();
  vi.stubGlobal("window", events);
  const postMessage = vi.fn();
  const target = { postMessage };
  const element = { src: "about:blank", contentWindow: target, getAttribute: () => element.src };
  const status = vi.fn();
  const controller = createReadonlyAppItemFrameController({
    element: element as unknown as HTMLIFrameElement,
    hostUrl: "http://localhost/space-app-preview.html",
    parentOrigin: "http://localhost",
    html: "<p>Authorized document</p>",
    ...(expiresAt === undefined ? {} : { expiresAt }),
    onStatus: status,
  });
  const nonce = new URLSearchParams(new URL(element.src).hash.slice(1)).get("nonce");
  const receive = (
    kind: string,
    extra: { nonce?: string; origin?: string; source?: unknown } = {},
  ) => {
    const event = new Event("message");
    Object.assign(event, {
      data: { protocol: READONLY_APP_ITEM_PROTOCOL, nonce: extra.nonce ?? nonce, kind },
      source: extra.source ?? target,
      origin: extra.origin ?? "null",
    });
    events.dispatchEvent(event);
  };
  return { ...controller, receive, element, status, postMessage };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readonly AppItem frame lifecycle", () => {
  it("only sends to the current source with the exact opaque origin and nonce", () => {
    const frame = setup();
    frame.receive("ready", { source: {} });
    frame.receive("ready", { origin: "http://localhost" });
    frame.receive("ready", { nonce: "previous-document" });
    expect(frame.postMessage).not.toHaveBeenCalled();
    frame.receive("ready");
    frame.receive("ready");
    expect(frame.postMessage).toHaveBeenCalledOnce();
    frame.receive("loaded");
    expect(frame.status).toHaveBeenLastCalledWith("ready");
    expect(vi.getTimerCount()).toBe(0);
    frame.receive("ready");
    expect(frame.postMessage).toHaveBeenCalledOnce();
    frame.dispose();
    expect(frame.element.src).toBe("about:blank");
  });

  it("expires a loaded guest frame and releases every handle", () => {
    const frame = setup(Date.now() + 3_000);
    frame.receive("ready");
    frame.receive("loaded");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3_000);
    expect(frame.status).toHaveBeenLastCalledWith("expired");
    expect(frame.element.src).toBe("about:blank");
    expect(vi.getTimerCount()).toBe(0);
    frame.receive("ready");
    expect(frame.postMessage).toHaveBeenCalledOnce();
    frame.dispose();
  });

  it("times out once without polling or retrying", () => {
    const frame = setup();
    vi.advanceTimersByTime(READONLY_APP_ITEM_TIMEOUT_MS);
    expect(frame.status).toHaveBeenLastCalledWith("timeout");
    expect(frame.element.src).toBe("about:blank");
    frame.receive("ready");
    expect(frame.postMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["switch", "unmount"])("clears a pending frame on %s", () => {
    const frame = setup(Date.now() + 20_000);
    frame.dispose();
    frame.receive("ready");
    expect(frame.element.src).toBe("about:blank");
    expect(frame.postMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([Number.NaN, 0])("never opens an invalid or expired grant: %s", (expiresAt) => {
    const frame = setup(expiresAt);
    expect(frame.status).toHaveBeenLastCalledWith("expired");
    expect(frame.element.src).toBe("about:blank");
    expect(vi.getTimerCount()).toBe(0);
    frame.dispose();
  });

  it("cleans up when posting the document fails", () => {
    const frame = setup();
    frame.postMessage.mockImplementation(() => {
      throw new Error("frame closed");
    });
    frame.receive("ready");
    expect(frame.status).toHaveBeenLastCalledWith("invalid");
    expect(frame.element.src).toBe("about:blank");
    expect(vi.getTimerCount()).toBe(0);
  });
});
