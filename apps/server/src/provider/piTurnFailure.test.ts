import { describe, expect, it } from "vitest";

import { classifyPiTurnFailure, piMissingModelSignInIssue } from "./piTurnFailure.ts";

describe("classifyPiTurnFailure", () => {
  it("treats Pi abort messages as interrupted turns", () => {
    expect(classifyPiTurnFailure("Error: Request was aborted.")).toEqual({
      state: "interrupted",
      stopReason: "aborted",
    });
  });

  it("treats retry-backoff cancellation as an interrupted turn", () => {
    // End task during SDK backoff settles with "Retry cancelled" — a
    // user-initiated interrupt, not a failure (issue #1027).
    for (const message of ["Retry cancelled", "retry canceled"]) {
      expect(classifyPiTurnFailure(message)).toEqual({
        state: "interrupted",
        stopReason: "aborted",
      });
    }
  });

  it("keeps rate-limit errors failed (SDK retry owns them, not the classifier)", () => {
    expect(
      classifyPiTurnFailure("[rate_limit_exceeded] Rate limit exceeded. Please retry ..."),
    ).toEqual({ state: "failed", stopReason: "error" });
  });

  it("keeps real Pi failures failed", () => {
    expect(classifyPiTurnFailure("Model provider returned a 500")).toEqual({
      state: "failed",
      stopReason: "error",
    });
  });
});

describe("piMissingModelSignInIssue", () => {
  it("says plainly that this Pi account cannot run the model, and what to do", () => {
    expect(
      piMissingModelSignInIssue("No API key for deepseek/deepseek-flash", {
        id: "deepseek-flash",
        name: "DeepSeek Flash",
      }),
    ).toBe(
      "This Pi account has no sign-in for DeepSeek Flash. Switch to Moss or another model to continue.",
    );
    expect(piMissingModelSignInIssue("No API key for xai/grok-4.7", { id: "grok-4.7" })).toBe(
      "This Pi account has no sign-in for grok-4.7. Switch to Moss or another model to continue.",
    );
  });

  it("leaves other failures to Pi's own message", () => {
    expect(piMissingModelSignInIssue("Model is busy", { id: "x" })).toBeNull();
  });
});
