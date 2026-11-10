// FILE: visualFollowUp.test.ts
// Purpose: A visual's follow-up lands in its own thread's composer, never another's.
// Layer: Web chat presentation logic tests

import { describe, expect, it } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { visualFollowUpForThread } from "./visualFollowUp";

describe("visualFollowUpForThread", () => {
  it("targets the named thread and leaves every other draft alone", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt("visual-other" as never, "unrelated draft");
    visualFollowUpForThread("visual-target")!("Show trains instead");
    const drafts = useComposerDraftStore.getState().draftsByThreadId;
    expect(drafts["visual-target" as never]?.prompt).toBe("Show trains instead");
    expect(drafts["visual-other" as never]?.prompt).toBe("unrelated draft");
  });

  it("has no handler outside a thread, so pages get an error instead", () => {
    expect(visualFollowUpForThread(null)).toBeNull();
  });
});
