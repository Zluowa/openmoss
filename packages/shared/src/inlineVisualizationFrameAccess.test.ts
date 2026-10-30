import { describe, expect, it } from "vitest";

import {
  INLINE_VISUALIZATION_FRAME_ACCESS_TTL_MS,
  signInlineVisualizationFrameAccess,
  verifyInlineVisualizationFrameAccess,
} from "./inlineVisualizationFrameAccess";

const nowMs = 1_800_000_000_000;
const input = {
  token: "test-token",
  threadId: "moss-thread",
  path: "/codex/visualizations/2026/10/08/native-thread/chart.html",
  sha256: "a".repeat(64),
  expiresAtMs: nowMs + INLINE_VISUALIZATION_FRAME_ACCESS_TTL_MS,
};

describe("inline visualization frame access", () => {
  it("rejects changed identity, expiration and malformed signatures", async () => {
    const signature = await signInlineVisualizationFrameAccess(input);
    const valid = {
      ...input,
      expires: String(input.expiresAtMs),
      signature,
      nowMs,
    };
    for (const change of [
      { token: "another-token" },
      { threadId: "another-thread" },
      { path: "/codex/visualizations/other/chart.html" },
      { expires: String(input.expiresAtMs + 1) },
      { nowMs: input.expiresAtMs },
      { nowMs: nowMs - 120_000 },
      { expires: null },
      { signature: null },
      { signature: "invalid" },
    ]) {
      await expect(verifyInlineVisualizationFrameAccess({ ...valid, ...change })).resolves.toBe(
        false,
      );
    }
  });

  it("is content locked to one visualization", async () => {
    const signature = await signInlineVisualizationFrameAccess(input);
    await expect(
      verifyInlineVisualizationFrameAccess({
        ...input,
        expires: String(input.expiresAtMs),
        signature,
        nowMs,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyInlineVisualizationFrameAccess({
        ...input,
        sha256: "b".repeat(64),
        expires: String(input.expiresAtMs),
        signature,
        nowMs,
      }),
    ).resolves.toBe(false);
  });
});
