// Accepting a multi-row composer prediction with Tab (or Right Arrow), in a composer that
// floats over a transcript following its end: the swap from ghost text to draft must not
// pass through a collapsed composer, or the reader at the end is left short of it.

import "../../index.css";

import type { LegendListRef } from "@legendapp/list/react";
import { ThreadId, TurnId } from "@moss/contracts";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { collapseExpandedComposerCursor } from "../../composer-logic";
import { useComposerPrediction } from "../../hooks/useComposerPrediction";
import {
  composerPredictionStore,
  shouldAcceptComposerPrediction,
  type ComposerPredictionTarget,
} from "../../lib/composerPrediction";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { composerTranscriptBottomInsetPx, useComposerOverlayHeight } from "./composerOverlay";
import {
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";

const nativeApi = vi.hoisted(() => ({ suggestion: "" }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    server: {
      generateComposerPrediction: async () => ({
        suggestion: nativeApi.suggestion,
        outcome: "suggested",
      }),
    },
  }),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-accept");
const TARGET: ComposerPredictionTarget = {
  key: "accept-key",
  threadId: THREAD_ID,
  turnId: TurnId.makeUnsafe("turn-accept"),
};
const EMPTY_TIMELINE: [] = [];
// Wraps past the three rows the ghost shows at this width, so the draft is taller still.
const LONG_SUGGESTION =
  "ok go ahead with the first two steps, but leave the third out for now, I do not want to touch the production table until we have a backup. tell me when both are done so I can check, then rerun the migration dry run against staging and open the pull request";

const waitForFrames = (count = 3) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(count);
  });

function AcceptHarness() {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const listRef = useRef({
    scrollToEnd: async () => {
      const node = transcriptRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    },
    getScrollableNode: () => transcriptRef.current,
  } as unknown as LegendListRef);
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const prediction = useComposerPrediction({
    target: TARGET,
    canShow: prompt.length === 0,
    prompt,
  });
  const { overlayRef, overlayHeightPx } = useComposerOverlayHeight();
  const insetPx = composerTranscriptBottomInsetPx(overlayHeightPx);
  useChatTranscriptScroll({
    activeThreadId: THREAD_ID,
    legendListRef: listRef,
    timelineEntries: EMPTY_TIMELINE,
    hasStreamingAssistantText: false,
    composerTranscriptInsetPx: insetPx,
    isInactiveSplitPane: false,
  });

  // The chat's accept branch: accept on the editor's current state, write the full draft.
  // Escape drops the suggestion for the turn instead.
  const onCommandKeyDown = (key: string, event: KeyboardEvent) => {
    if (key !== "Tab" && key !== "ArrowRight" && key !== "Escape") return false;
    const editor = editorRef.current;
    const visible = prediction.controller.readVisible();
    if (
      !editor ||
      !visible ||
      !shouldAcceptComposerPrediction({
        event,
        editorFocused: editor.isFocused(),
        snapshot: editor.readSnapshot(),
        prediction: visible,
        entry: prediction.controller.readEntry(visible.key),
      })
    ) {
      return false;
    }
    if (key === "Escape") {
      prediction.controller.dismiss(visible);
      return true;
    }
    prediction.controller.accept(visible);
    setPrompt(visible.suggestion);
    setCursor(collapseExpandedComposerCursor(visible.suggestion, visible.suggestion.length));
    return true;
  };

  return (
    <div style={{ position: "relative", width: 640, height: 480 }}>
      <div data-testid="transcript" ref={transcriptRef} style={{ height: 480, overflow: "auto" }}>
        <div style={{ height: 2000, paddingBottom: insetPx }} />
      </div>
      <div ref={overlayRef} style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
        <form data-testid="accept-form">
          <div data-chat-composer-surface="" className={COMPOSER_INPUT_SURFACE_CLASS_NAME}>
            <div className={COMPOSER_EDITOR_PADDING_CLASS_NAME}>
              <ComposerPromptEditor
                ref={editorRef}
                value={prompt}
                cursor={cursor}
                terminalContexts={[]}
                disabled={false}
                placeholder="Ask for follow-up changes"
                prediction={prediction.ghost}
                onRemoveTerminalContext={() => {}}
                onPaste={() => {}}
                onChange={(nextValue, nextCursor) => {
                  setPrompt(nextValue);
                  setCursor(nextCursor);
                }}
                onCommandKeyDown={onCommandKeyDown}
              />
            </div>
            {/* The composer keeps one shape: the editor, then its footer row. */}
            <div style={{ height: 40 }}>
              <button type="button">Send</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const transcript = () => document.querySelector<HTMLElement>('[data-testid="transcript"]')!;
const gapFromEnd = () => {
  const node = transcript();
  return node.scrollHeight - node.clientHeight - node.scrollTop;
};
const ghostRows = () => {
  const ghost = document.querySelector<HTMLElement>('[data-testid="composer-prediction"]');
  if (!ghost) return 0;
  return Math.round(
    ghost.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(ghost).lineHeight),
  );
};

async function mountWithSuggestion(suggestion: string) {
  nativeApi.suggestion = suggestion;
  await render(<AcceptHarness />);
  await expect.poll(() => ghostRows()).toBeGreaterThan(0);
  await waitForFrames();
}

describe("accepting a composer prediction with Tab", () => {
  beforeEach(async () => {
    await page.viewport(800, 600);
    composerPredictionStore.setState({ entries: new Map(), settledKeys: new Set() });
  });
  afterEach(cleanup);

  it("keeps a reader at the end exactly at the end when a multi-row suggestion is accepted", async () => {
    await mountWithSuggestion(LONG_SUGGESTION);
    expect(ghostRows()).toBe(3);
    transcript().scrollTop = transcript().scrollHeight;
    await waitForFrames();
    expect(gapFromEnd()).toBeLessThan(1);

    document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!.focus();
    await userEvent.keyboard("{Tab}");
    await expect
      .poll(() => document.querySelector('[data-testid="composer-editor"]')!.textContent)
      .toBe(LONG_SUGGESTION);
    await waitForFrames(6);

    expect(gapFromEnd()).toBeLessThan(1);
    expect(document.querySelector('[data-testid="composer-prediction"]')).toBeNull();
    expect(composerPredictionStore.getState().entries.get(TARGET.key)?.status).toBe("done");
  });

  it("leaves a reader who scrolled up where they were", async () => {
    await mountWithSuggestion(LONG_SUGGESTION);
    transcript().scrollTop = 150;
    await waitForFrames();

    document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!.focus();
    await userEvent.keyboard("{Tab}");
    await expect
      .poll(() => document.querySelector('[data-testid="composer-editor"]')!.textContent)
      .toBe(LONG_SUGGESTION);
    await waitForFrames(6);

    expect(transcript().scrollTop).toBe(150);
  });

  it("accepts with Right Arrow through the editor", async () => {
    await mountWithSuggestion("Rerun that test.");
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    editor.focus();

    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => editor.textContent).toBe("Rerun that test.");
    expect(composerPredictionStore.getState().entries.get(TARGET.key)?.status).toBe("done");
  });

  it("accepts a one-row suggestion without moving the composer", async () => {
    await mountWithSuggestion("Rerun that test.");
    const form = document.querySelector<HTMLElement>('[data-testid="accept-form"]')!;
    transcript().scrollTop = transcript().scrollHeight;
    await waitForFrames();
    const height = form.getBoundingClientRect().height;

    document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!.focus();
    await userEvent.keyboard("{Tab}");
    await expect
      .poll(() => document.querySelector('[data-testid="composer-editor"]')!.textContent)
      .toBe("Rerun that test.");
    await waitForFrames(6);

    expect(form.getBoundingClientRect().height).toBeCloseTo(height, 1);
    expect(gapFromEnd()).toBeLessThan(1);
  });

  // Chinese, Japanese and Korean input: Tab or Right Arrow while a composition is open belongs
  // to the IME (picking a candidate, moving inside it) and must never take the suggestion.
  it.each(["Tab", "ArrowRight"])(
    "leaves %s to an open IME composition and accepts once it ends",
    async (key) => {
      await mountWithSuggestion("Rerun that test.");
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
      editor.focus();
      const press = (init: KeyboardEventInit) =>
        editor.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code: key,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );

      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      // Browsers report a key the IME handles as composing, keyCode 229.
      press({ isComposing: true, keyCode: 229 });
      press({ isComposing: false, keyCode: 229 });
      press({ isComposing: true, keyCode: key === "Tab" ? 9 : 39 });
      await waitForFrames();
      // Lexical marks an open composition with zero-width spaces; nothing else was written.
      expect(editor.textContent?.replace(/\u200b/gu, "")).toBe("");
      expect(composerPredictionStore.getState().entries.get(TARGET.key)?.status).toBe("ready");

      editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      await waitForFrames();
      await userEvent.keyboard(`{${key}}`);
      await expect.poll(() => editor.textContent).toBe("Rerun that test.");
    },
  );

  it.each([
    ["Enter", "{Enter}"],
    ["Shift+Tab", "{Shift>}{Tab}{/Shift}"],
    ["Alt+Right Arrow", "{Alt>}{ArrowRight}{/Alt}"],
    ["Control+Tab", "{Control>}{Tab}{/Control}"],
  ])("does not accept with %s", async (_label, keys) => {
    await mountWithSuggestion("Rerun that test.");
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    editor.focus();

    await userEvent.keyboard(keys);
    await waitForFrames();

    expect(editor.textContent).toBe("");
    expect(composerPredictionStore.getState().entries.get(TARGET.key)?.status).toBe("ready");
  });

  it("drops the suggestion for the turn with Escape and writes nothing", async () => {
    await mountWithSuggestion("Rerun that test.");
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    editor.focus();

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => ghostRows()).toBe(0);
    expect(editor.textContent).toBe("");
    expect(composerPredictionStore.getState().entries.get(TARGET.key)?.status).toBe("done");
    expect(composerPredictionStore.getState().settledKeys.has(TARGET.key)).toBe(true);
  });
});
