import { SECRET_REQUEST_ERROR_CODES, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestServerMessage,
} from "./SecretRequestCard.logic";

const THREAD = ThreadId.makeUnsafe("thread-secret");
const REQUEST = { requestId: `secret-request:${"a".repeat(32)}` };

describe("secretRequestDisplay", () => {
  it("shows the form until the request settles", () => {
    expect(secretRequestDisplay({})).toEqual({ kind: "pending" });
    expect(secretRequestDisplay({ outcome: "saved" })).toEqual({
      kind: "settled",
      outcome: "saved",
      labelKey: "chat.secretRequest.outcome.saved",
    });
    expect(secretRequestDisplay({ outcome: "timed_out" })).toMatchObject({
      outcome: "timed_out",
      labelKey: "chat.secretRequest.outcome.timedOut",
    });
  });

  it("drops the form as soon as this window's answer is accepted", () => {
    expect(secretRequestDisplay({}, "declined")).toMatchObject({
      kind: "settled",
      labelKey: "chat.secretRequest.outcome.declined",
    });
    // The server's settled card is the authority once it arrives.
    expect(secretRequestDisplay({ outcome: "cancelled" }, "saved")).toMatchObject({
      outcome: "cancelled",
    });
  });
});

describe("secretRequestAnswerInput", () => {
  it("trims a saved value and refuses a blank one", () => {
    expect(secretRequestAnswerInput(THREAD, REQUEST, { type: "save", secret: "  tok  " })).toEqual({
      threadId: THREAD,
      requestId: REQUEST.requestId,
      answer: { type: "save", secret: "tok" },
    });
    expect(secretRequestAnswerInput(THREAD, REQUEST, { type: "save", secret: "   " })).toBeNull();
    expect(secretRequestAnswerInput(THREAD, REQUEST, { type: "decline" })).toEqual({
      threadId: THREAD,
      requestId: REQUEST.requestId,
      answer: { type: "decline" },
    });
  });
});

describe("secretRequestServerMessage", () => {
  it("passes through only the server's own refusals", () => {
    expect(
      secretRequestServerMessage({
        code: SECRET_REQUEST_ERROR_CODES.alreadyAnswered,
        message: "This request was already answered.",
      }),
    ).toBe("This request was already answered.");
  });

  it("never echoes other failures, which could quote the typed value", () => {
    expect(secretRequestServerMessage(new Error('Expected a string, got "ghp_value"'))).toBeNull();
    expect(secretRequestServerMessage({ code: "OTHER", message: "ghp_value" })).toBeNull();
    expect(
      secretRequestServerMessage({ code: SECRET_REQUEST_ERROR_CODES.notFound, message: " " }),
    ).toBeNull();
    expect(secretRequestServerMessage(undefined)).toBeNull();
  });
});
