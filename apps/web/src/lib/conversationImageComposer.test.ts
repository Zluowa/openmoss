import { describe, expect, it, vi } from "vitest";
import {
  flushConversationImageEditors,
  getConversationImageComposer,
  registerConversationImageComposer,
  registerConversationImageLeaveGuard,
} from "./conversationImageComposer";

describe("image workspace composer ownership", () => {
  it("keeps an inactive editor leave guard after its composer slot moves to another tab", async () => {
    const failed = vi.fn(async () => false);
    const releaseGuard = registerConversationImageLeaveGuard("thread", "image-pane", failed);
    const releaseSlot = registerConversationImageComposer("thread", {
      target: null,
      beforeSend: failed,
      beforeLeave: failed,
    });
    releaseSlot();
    expect(getConversationImageComposer("thread")).toBeNull();
    expect(await flushConversationImageEditors("thread", "image-pane")).toBe(false);
    expect(failed).toHaveBeenCalledOnce();
    releaseGuard();
    expect(await flushConversationImageEditors("thread")).toBe(true);
  });
  it("does not let old disposal remove a new owner and isolates threads", async () => {
    const first = { target: null, beforeSend: async () => false, beforeLeave: async () => false };
    const next = { target: null, beforeSend: async () => true, beforeLeave: async () => true };
    const old = registerConversationImageComposer("a", first);
    const current = registerConversationImageComposer("a", next);
    old();
    expect(getConversationImageComposer("a")).toBe(next);
    expect(getConversationImageComposer("b")).toBeNull();
    const guard = registerConversationImageLeaveGuard("a", "pane", async () => {
      throw Error("save failed");
    });
    expect(await flushConversationImageEditors("a")).toBe(false);
    expect(await flushConversationImageEditors("b")).toBe(true);
    guard();
    current();
  });
});
