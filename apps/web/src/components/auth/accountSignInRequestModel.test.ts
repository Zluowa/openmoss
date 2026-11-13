// FILE: accountSignInRequestModel.test.ts
// Purpose: Which waiting phone the confirmation shows, its countdown, title and notification.
// Layer: Auth UI model tests
// Exports: none
import { DateTime } from "effect";
import { describe, expect, it } from "vitest";

import {
  accountSignInSecondsLeft,
  accountSignInTitle,
  freshAccountSignInRequestIds,
  groupedCheckCode,
  lapsedAccountSignInRequest,
  shouldNotifyAccountSignIn,
  waitingAccountSignInRequests,
} from "./accountSignInRequestModel";

const NOW = Date.UTC(2026, 10, 13, 8, 0, 0);
const request = (requestId: string, expiresInMs: number, deviceName: string | null = "Pixel") => ({
  requestId,
  deviceName,
  accountLabel: "138****8000",
  checkCode: "4815",
  expiresAt: DateTime.makeUnsafe(NOW + expiresInMs),
});

describe("account sign-in confirmation model", () => {
  it("shows the oldest request first and hides expired ones", () => {
    const shown = waitingAccountSignInRequests(
      { requests: [request("b", 90_000), request("gone", -1), request("a", 30_000)] },
      NOW,
    );
    expect(shown.map((entry) => entry.requestId)).toEqual(["a", "b"]);
    expect(shown[0]).toEqual({
      requestId: "a",
      deviceName: "Pixel",
      accountLabel: "138****8000",
      checkCode: "4815",
      expiresAtMs: NOW + 30_000,
    });
  });

  it("counts down in whole seconds and never below zero", () => {
    expect(accountSignInSecondsLeft({ expiresAtMs: NOW + 1_500 }, NOW)).toBe(2);
    expect(accountSignInSecondsLeft({ expiresAtMs: NOW - 10 }, NOW)).toBe(0);
  });

  it("names the phone when it gave a name", () => {
    expect(accountSignInTitle({ deviceName: "Pixel" })).toEqual({
      key: "auth.accountSignIn.title",
      device: "Pixel",
    });
    expect(accountSignInTitle({ deviceName: null })).toEqual({
      key: "auth.accountSignIn.titleUnnamed",
    });
  });

  it("spaces the check code digits", () => {
    expect(groupedCheckCode("0481")).toBe("0 4 8 1");
  });

  it("tells the system once per new phone, and only when the window is not in front", () => {
    const seen = new Set<string>();
    const first = freshAccountSignInRequestIds(seen, [{ requestId: "a" }]);
    expect(first).toEqual(["a"]);
    expect(freshAccountSignInRequestIds(seen, [{ requestId: "a" }])).toEqual([]);
    expect(shouldNotifyAccountSignIn(first, false)).toBe(true);
    expect(shouldNotifyAccountSignIn(first, true)).toBe(false);
    expect(shouldNotifyAccountSignIn([], false)).toBe(false);
  });

  it("says a request lapsed only when it ran out unanswered here", () => {
    const shown = { requestId: "a", expiresAtMs: NOW };
    const none = new Set<string>();
    expect(lapsedAccountSignInRequest({ shown, waiting: [], decidedHere: none, nowMs: NOW })).toBe(
      true,
    );
    // Still waiting, answered here, dropped early, or nothing shown: no line.
    expect(
      lapsedAccountSignInRequest({
        shown,
        waiting: [{ requestId: "a" }],
        decidedHere: none,
        nowMs: NOW,
      }),
    ).toBe(false);
    expect(
      lapsedAccountSignInRequest({ shown, waiting: [], decidedHere: new Set(["a"]), nowMs: NOW }),
    ).toBe(false);
    expect(
      lapsedAccountSignInRequest({ shown, waiting: [], decidedHere: none, nowMs: NOW - 1 }),
    ).toBe(false);
    expect(
      lapsedAccountSignInRequest({ shown: null, waiting: [], decidedHere: none, nowMs: NOW }),
    ).toBe(false);
  });
});
