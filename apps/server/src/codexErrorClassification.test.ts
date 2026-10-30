import { describe, expect, it } from "vitest";

import {
  codexErrorMessage,
  humanizeCodexRuntimeErrorMessage,
  isNonRetryableCodexGatewayErrorMessage,
} from "./codexErrorClassification.ts";

describe("codexErrorMessage", () => {
  it("preserves legacy text and safely names forward-compatible variants", () => {
    expect(codexErrorMessage("  connection reset  ")).toBe("connection reset");
    expect(codexErrorMessage({ message: "request denied" })).toBe("request denied");
    expect(codexErrorMessage({ flexUnavailable: { retryAfter: 30 } })).toBe(
      "Codex error: flexUnavailable",
    );
  });
});

describe("humanizeCodexRuntimeErrorMessage", () => {
  it("reports the shared package as exhausted without a periodic reset or separate recharge", () => {
    expect(
      humanizeCodexRuntimeErrorMessage(
        'HTTP 429 {"error":{"code":"service_cost_budget_exhausted"}}',
      ),
    ).toBe("Your Moss package usage allowance is exhausted.");
  });
  it("returns a quota message for token_quota_exhausted bodies", () => {
    const message = humanizeCodexRuntimeErrorMessage(
      'error: exceeded retry limit, last status: 429 Too Many Requests {"error":{"message":"The Moss account quota for this period is exhausted.","type":"rate_limit_error","code":"token_quota_exhausted"}}',
    );
    expect(message).toContain("quota");
    expect(message).not.toContain("exceeded retry limit");
  });

  it("matches the quota code without requiring a surrounding 429", () => {
    expect(humanizeCodexRuntimeErrorMessage("token_quota_exhausted")).toContain("quota");
  });

  it("recognizes managed request-quota exhaustion", () => {
    const message = humanizeCodexRuntimeErrorMessage(
      'error: 429 Too Many Requests {"error":{"code":"request_quota_exhausted"}}',
    );
    expect(message).toContain("quota");
    expect(message).not.toMatch(/rate limiting requests right now/i);
  });

  it("mentions the reset time when a retry-after hint is present", () => {
    const message = humanizeCodexRuntimeErrorMessage(
      "status=429 Too Many Requests retry-after: 552649",
    );
    expect(message).toMatch(/rate limiting/i);
    expect(message).toMatch(/try again in/i);
  });

  it("returns a billing message for insufficient quota phrasing", () => {
    const message = humanizeCodexRuntimeErrorMessage(
      "error: 429 insufficient_quota: You exceeded your current quota",
    );
    expect(message).toContain("quota");
  });

  it("returns a rate-limit message for plain 429s without a quota signal", () => {
    const message = humanizeCodexRuntimeErrorMessage(
      "error: exceeded retry limit, last status: 429 Too Many Requests",
    );
    expect(message).toBeTruthy();
    expect(message).not.toContain("exceeded retry limit");
  });

  it.each([
    "unexpected status 524 <unknown status code>: error code: 524, url: https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1/responses, cf-ray: a378c7607cf7d287-CMH",
    "HTTP 502 bad gateway from the model gateway",
    "gateway timeout while waiting for the upstream response",
  ])("treats hard gateway failures as non-retryable: %s", (message) => {
    expect(isNonRetryableCodexGatewayErrorMessage(message)).toBe(true);
  });

  it("returns undefined for unrelated errors", () => {
    expect(
      humanizeCodexRuntimeErrorMessage("write_stdin failed: stdin is closed for this session"),
    ).toBeUndefined();
    expect(humanizeCodexRuntimeErrorMessage("connection reset by peer")).toBeUndefined();
    expect(isNonRetryableCodexGatewayErrorMessage("connection reset by peer")).toBe(false);
  });

  it("humanizes the exact rollout stream error observed in production", () => {
    // Captured from a managed Codex rollout: the turn failed with the quota code
    // embedded in the retry-limit stream error, alongside a retry-after hint.
    const message = humanizeCodexRuntimeErrorMessage(
      "stream error: exceeded retry limit, last status: 429 Too Many Requests; " +
        'retrying 1/5 in 191ms… {"error":{"code":"token_quota_exhausted"}} retry-after: 552649',
    );
    expect(message).toContain("quota");
    expect(message).toMatch(/try again in about 6d/i);
    expect(message).not.toContain("exceeded retry limit");
  });
});
