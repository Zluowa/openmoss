import {
  GUEST_ACCESS_ERROR_MESSAGES,
  GUEST_ROUTES,
  GuestShareEndReason,
  guestApiPath,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { GUEST_ACCESS_ERROR_KEY, GUEST_END_REASON_KEY } from "./guestCopy";
import { parseGuestErrorBody, parseGuestStreamEvent } from "./protocol";
import { createHttpGuestTransport } from "./transport";

describe("guest routes", () => {
  it("builds every route under the share's guest prefix", () => {
    for (const route of Object.values(GUEST_ROUTES)) {
      expect(guestApiPath("abc", route)).toBe(`/v1/shares/abc/guest/${route}`);
    }
    expect(createHttpGuestTransport("abc").attachmentUrl("file 1")).toBe(
      "/v1/shares/abc/guest/attachment?id=file%201",
    );
  });

  it("has copy for every reason the server can send", () => {
    expect(Object.keys(GUEST_ACCESS_ERROR_KEY).toSorted()).toEqual(
      Object.keys(GUEST_ACCESS_ERROR_MESSAGES).toSorted(),
    );
    expect(Object.keys(GUEST_END_REASON_KEY).toSorted()).toEqual(
      GuestShareEndReason.literals.toSorted(),
    );
  });
});

describe("parseGuestErrorBody", () => {
  it("keeps known reasons and the server message, and tolerates junk", () => {
    expect(parseGuestErrorBody({ reason: "used", message: "Used." })).toEqual({
      reason: "used",
      message: "Used.",
    });
    expect(parseGuestErrorBody({ reason: "future_reason", message: "Later." })).toEqual({
      reason: null,
      message: "Later.",
    });
    expect(parseGuestErrorBody(null)).toEqual({ reason: null, message: null });
    expect(parseGuestErrorBody("nope")).toEqual({ reason: null, message: null });
  });
});

describe("parseGuestStreamEvent", () => {
  it("decodes the frames of the protocol", () => {
    expect(parseGuestStreamEvent(JSON.stringify({ type: "hello", protocolVersion: 1 }))).toEqual({
      type: "hello",
      protocolVersion: 1,
    });
    const view = {
      shareId: "k3J9xQ2mT8vL5nR1pW7yZa",
      guestName: "Sam",
      expiresAt: "2026-10-30T00:00:00.000Z",
      messages: [],
      model: { provider: "codex", name: "gpt-5.3-codex" },
    };
    expect(parseGuestStreamEvent(JSON.stringify({ type: "view", view }))).toEqual({
      type: "view",
      view,
    });
    expect(parseGuestStreamEvent(JSON.stringify({ type: "ended", reason: "expired" }))).toEqual({
      type: "ended",
      reason: "expired",
    });
  });

  it("ignores unknown types and malformed frames instead of failing", () => {
    expect(parseGuestStreamEvent(JSON.stringify({ type: "typing", who: "owner" }))).toBeNull();
    expect(parseGuestStreamEvent("{not json")).toBeNull();
    expect(parseGuestStreamEvent(JSON.stringify({ type: "ended", reason: "vanished" }))).toBeNull();
    expect(
      parseGuestStreamEvent(JSON.stringify({ type: "thread", item: { kind: "?" } })),
    ).toBeNull();
    expect(parseGuestStreamEvent(JSON.stringify([]))).toBeNull();
  });
});
