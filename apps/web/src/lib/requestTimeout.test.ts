import { afterEach, describe, expect, it, vi } from "vitest";

import { RequestTimeoutError, withRequestTimeout } from "./requestTimeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withRequestTimeout", () => {
  it("fails a request that never answers once its limit passes", async () => {
    vi.useFakeTimers();
    const pending = withRequestTimeout(new Promise<never>(() => {}), 60_000, "codex plugin list");
    const outcome = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    await expect(pending).rejects.toThrow("codex plugin list did not answer within 60 s.");
  });

  it("passes an answer or a failure through unchanged", async () => {
    await expect(withRequestTimeout(Promise.resolve("listed"), 1_000, "list")).resolves.toBe(
      "listed",
    );
    const failure = new Error("signed out");
    await expect(withRequestTimeout(Promise.reject(failure), 1_000, "list")).rejects.toBe(failure);
  });
});
