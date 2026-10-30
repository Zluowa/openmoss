import { describe, expect, it } from "vitest";

import {
  applyComposerPrediction,
  createPredictionTriggerTracker,
  deriveModelComposerPrediction,
} from "./composerPrediction";
import { splitPromptIntoComposerSegments } from "../../composer-editor-mentions";

describe("composer prediction", () => {
  it("only derives a model prediction for an empty composer", () => {
    expect(deriveModelComposerPrediction({ prompt: "please", text: "please review" })).toBeNull();
    expect(deriveModelComposerPrediction({ prompt: "", text: "继续检查测试" })).toEqual({
      value: "继续检查测试",
      suffix: "继续检查测试",
    });
  });

  it("applies a current prediction and rejects one that became stale", () => {
    const prediction = {
      value: "Please review the current changes",
      suffix: "Please review the current changes",
    };
    expect(applyComposerPrediction("Please", prediction)).toBe("Please");
    expect(applyComposerPrediction("", prediction)).toBe("Please review the current changes");
    expect(applyComposerPrediction("Please inspect", prediction)).toBe("Please inspect");
  });

  it("turns a model prediction into an empty-composer completion", () => {
    expect(deriveModelComposerPrediction({ prompt: "", text: "继续检查测试" })).toEqual({
      value: "继续检查测试",
      suffix: "继续检查测试",
    });
  });

  it("does not show a model prediction after the user starts typing", () => {
    expect(deriveModelComposerPrediction({ prompt: "继续", text: "继续检查测试" })).toBeNull();
    expect(deriveModelComposerPrediction({ prompt: "", text: "   " })).toBeNull();
  });

  it("keeps accepted mention and skill tokens on the shared composer parse path", () => {
    // Accept writes through setComposerPromptValue → $setComposerEditorPrompt →
    // splitPromptIntoComposerSegments; trailing delimiters complete chip tokens.
    const accepted = applyComposerPrediction("", {
      value: "Inspect @src/index.ts with $check-code please",
      suffix: "Inspect @src/index.ts with $check-code please",
    });
    expect(splitPromptIntoComposerSegments(accepted)).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "src/index.ts", tokenLength: "@src/index.ts".length },
      { type: "text", text: " with " },
      { type: "skill", name: "check-code", prefix: "$" },
      { type: "text", text: " please" },
    ]);
  });

  it("labels only the first request after a watched turn settles as live", () => {
    const tracker = createPredictionTriggerTracker();
    // Mounted on an idle thread: Codex's catch-up path.
    expect(tracker.takeTrigger("thread-1:turn-1")).toBe("catch_up");

    tracker.observeActiveTurn("thread-1:turn-2");
    expect(tracker.takeTrigger("thread-1:turn-2")).toBe("live");
    // A focus refresh for the same turn catches up on the shared prediction.
    expect(tracker.takeTrigger("thread-1:turn-2")).toBe("catch_up");

    // Switching threads after watching another turn run is not live for the new thread.
    tracker.observeActiveTurn("thread-1:turn-3");
    expect(tracker.takeTrigger("thread-2:turn-9")).toBe("catch_up");
  });
});
