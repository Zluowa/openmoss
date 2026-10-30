// FILE: openUIReflow.test.ts
// Purpose: Verify OpenUI action → conversation reflow mapping (message
//          building, URL routing, composer draft injection).
// Layer: Web chat presentation logic tests

import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { useComposerFocusRequestStore } from "../composerFocusRequestStore";
import {
  buildOpenUIFollowUpMessage,
  injectOpenUIFollowUpIntoComposer,
  resolveOpenUIActionDispatch,
  summarizeOpenUIFormState,
} from "./openUIReflow";

describe("summarizeOpenUIFormState", () => {
  it("flattens form fields into form.field: value lines", () => {
    expect(
      summarizeOpenUIFormState({
        booking: {
          city: { value: "Paris", componentType: "Input" },
          guests: { value: 2, componentType: "Slider" },
          newsletter: { value: false, componentType: "SwitchItem" },
        },
      }),
    ).toEqual(["booking.city: Paris", "booking.guests: 2", "booking.newsletter: false"]);
  });

  it("skips reactive bindings, empty values and malformed entries", () => {
    expect(
      summarizeOpenUIFormState({
        $draft: "reactive",
        booking: {
          city: { value: "  " },
          note: { value: null },
          tags: { value: ["a", "b"] },
        },
        stray: "not-a-field-map",
      }),
    ).toEqual(["booking.tags: a, b"]);
  });

  it("caps the number of emitted lines", () => {
    const fields = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`f${index}`, { value: index }]),
    );
    expect(summarizeOpenUIFormState({ big: fields })).toHaveLength(24);
  });
});

describe("buildOpenUIFollowUpMessage", () => {
  it("uses the human-friendly label alone when there is no form state", () => {
    expect(
      buildOpenUIFollowUpMessage({
        type: "continue_conversation",
        humanFriendlyMessage: "Tell me more about the Louvre",
      }),
    ).toBe("Tell me more about the Louvre");
  });

  it("appends the filled form state under the label", () => {
    expect(
      buildOpenUIFollowUpMessage({
        type: "submit",
        humanFriendlyMessage: "Book the trip",
        formState: { booking: { city: { value: "Paris" } } },
      }),
    ).toBe("Book the trip\n\nbooking.city: Paris");
  });

  it("falls back to a generic label and truncates very long messages", () => {
    expect(buildOpenUIFollowUpMessage({ type: "custom" })).toBe("OpenUI action");
    const long = buildOpenUIFollowUpMessage({
      type: "submit",
      humanFriendlyMessage: "x".repeat(5000),
    });
    expect(long.length).toBe(4000);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("resolveOpenUIActionDispatch", () => {
  it("routes http(s) open_url actions out of the app", () => {
    expect(
      resolveOpenUIActionDispatch({
        type: "open_url",
        params: { url: "https://openui.com" },
        humanFriendlyMessage: "Open docs",
      }),
    ).toEqual({ kind: "open-url", url: "https://openui.com" });
  });

  it("refuses non-http(s) URLs", () => {
    expect(
      resolveOpenUIActionDispatch({ type: "open_url", params: { url: "file:///etc/passwd" } }),
    ).toEqual({ kind: "ignore" });
    expect(resolveOpenUIActionDispatch({ type: "open_url", params: {} })).toEqual({
      kind: "ignore",
    });
  });

  it("reflows labeled actions as follow-up messages", () => {
    expect(
      resolveOpenUIActionDispatch({
        type: "continue_conversation",
        humanFriendlyMessage: "Show examples",
      }),
    ).toEqual({ kind: "follow-up", message: "Show examples" });
  });

  it("ignores actions without a usable label", () => {
    expect(resolveOpenUIActionDispatch({ type: "custom", humanFriendlyMessage: "  " })).toEqual({
      kind: "ignore",
    });
  });
});

describe("injectOpenUIFollowUpIntoComposer", () => {
  it("seeds an empty composer draft and requests focus", () => {
    const threadId = ThreadId.makeUnsafe("openui-test-empty");
    injectOpenUIFollowUpIntoComposer(threadId, "Tell me more");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "Tell me more",
    );
    expect(
      useComposerFocusRequestStore.getState().requestsByThreadId[threadId] ?? 0,
    ).toBeGreaterThan(0);
  });

  it("appends to an existing draft instead of overwriting it", () => {
    const threadId = ThreadId.makeUnsafe("openui-test-append");
    useComposerDraftStore.getState().setPrompt(threadId, "draft in progress");
    injectOpenUIFollowUpIntoComposer(threadId, "Follow-up question");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "draft in progress\n\nFollow-up question",
    );
  });
});
