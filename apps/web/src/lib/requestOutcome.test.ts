import { describe, expect, it } from "vitest";

import { isRequestOutcomeUnknown } from "./requestOutcome";

const interrupted = (code: string) => ({ _tag: "WsTransportRequestInterruptedError", code });

describe("isRequestOutcomeUnknown", () => {
  it.each(["WS_REQUEST_TIMEOUT", "WS_REQUEST_RECONNECTED"])("%s may have been applied", (code) => {
    expect(isRequestOutcomeUnknown(interrupted(code))).toBe(true);
  });

  it.each(["WS_REQUEST_ABORTED", "WS_REQUEST_NOT_SENT"])("%s is a known outcome", (code) => {
    expect(isRequestOutcomeUnknown(interrupted(code))).toBe(false);
  });

  it("ignores anything else", () => {
    expect(isRequestOutcomeUnknown(new Error("boom"))).toBe(false);
    expect(isRequestOutcomeUnknown(null)).toBe(false);
  });
});
