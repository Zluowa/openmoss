import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  consumeMossGoogleOAuthPurpose,
  recordMossGoogleOAuthPurpose,
} from "./mossGoogleOAuthPurpose";

describe("Moss Google OAuth purpose correlation", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          removeItem: (key: string) => storage.delete(key),
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("returns add-account only for the exact active flow and consumes it once", () => {
    recordMossGoogleOAuthPurpose({
      flowId: "flow-add-account",
      purpose: "add-account",
      expiresAt: "2026-08-17T02:00:00.000Z",
    });

    expect(
      consumeMossGoogleOAuthPurpose("different-flow", () => Date.parse("2026-08-17T01:00:00.000Z")),
    ).toBeNull();
    expect(
      consumeMossGoogleOAuthPurpose("flow-add-account", () =>
        Date.parse("2026-08-17T01:00:00.000Z"),
      ),
    ).toBe("add-account");
    expect(
      consumeMossGoogleOAuthPurpose("flow-add-account", () =>
        Date.parse("2026-08-17T01:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("rejects expired records and unavailable storage without blocking the callback", () => {
    recordMossGoogleOAuthPurpose({
      flowId: "flow-expired",
      purpose: "login",
      expiresAt: "2026-08-17T00:00:00.000Z",
    });
    expect(
      consumeMossGoogleOAuthPurpose("flow-expired", () => Date.parse("2026-08-17T01:00:00.000Z")),
    ).toBeNull();

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("storage unavailable");
        },
      },
    });
    expect(() => consumeMossGoogleOAuthPurpose("flow-any")).not.toThrow();
    expect(consumeMossGoogleOAuthPurpose("flow-any")).toBeNull();
  });
});
