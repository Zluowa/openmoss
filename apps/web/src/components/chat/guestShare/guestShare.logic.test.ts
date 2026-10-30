import {
  WsRpcError,
  type GuestShareId,
  type ThreadGuestShare,
  type ThreadId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { translateMoss } from "~/localization";
import {
  describeGuestShareError,
  formatGuestShareRemaining,
  readGuestShareErrorCode,
  resolveGuestShareIndicatorTone,
  resolveGuestSharePhase,
} from "./guestShare.logic";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");

function share(overrides: Partial<ThreadGuestShare> = {}): ThreadGuestShare {
  return {
    id: "AAAAAAAAAAAAAAAAAAAAAA" as GuestShareId,
    threadId: "thread-a" as ThreadId,
    relayOrigin: "https://moss-share.example",
    inviteUrl: "https://moss-share.example/s/AAAAAAAAAAAAAAAAAAAAAA#invite",
    createdAt: "2026-10-29T10:00:00.000Z",
    expiresAt: "2026-10-30T10:00:00.000Z",
    guestName: null,
    guestJoinedAt: null,
    messages: [],
    relayStatus: "online",
    ...overrides,
  };
}

describe("resolveGuestSharePhase / resolveGuestShareIndicatorTone", () => {
  it("reads waiting, joined, and expired from the share", () => {
    expect(resolveGuestSharePhase(share(), NOW)).toBe("waiting");
    expect(resolveGuestSharePhase(share({ guestName: "Ada" }), NOW)).toBe("joined");
    expect(resolveGuestSharePhase(share({ expiresAt: "2026-10-29T11:00:00.000Z" }), NOW)).toBe(
      "expired",
    );
  });

  it("maps relay health and phase onto one indicator tone", () => {
    expect(resolveGuestShareIndicatorTone(share(), NOW)).toBe("waiting");
    expect(resolveGuestShareIndicatorTone(share({ guestName: "Ada" }), NOW)).toBe("live");
    expect(
      resolveGuestShareIndicatorTone(share({ guestName: "Ada", relayStatus: "connecting" }), NOW),
    ).toBe("waiting");
    expect(resolveGuestShareIndicatorTone(share({ relayStatus: "offline" }), NOW)).toBe("offline");
    expect(
      resolveGuestShareIndicatorTone(share({ expiresAt: "2026-10-29T11:00:00.000Z" }), NOW),
    ).toBeNull();
  });
});

describe("formatGuestShareRemaining", () => {
  it("formats hours and minutes in both locales", () => {
    const expiresAt = "2026-10-30T11:15:00.000Z";
    expect(formatGuestShareRemaining(expiresAt, NOW, "en")).toBe("23h 15m");
    expect(formatGuestShareRemaining(expiresAt, NOW, "zh-CN")).toBe("23 小时 15 分钟");
    expect(formatGuestShareRemaining("2026-10-29T12:40:00.000Z", NOW, "en")).toBe("40m");
    expect(formatGuestShareRemaining("2026-10-29T12:00:30.000Z", NOW, "en")).toBe("under a minute");
    expect(formatGuestShareRemaining("2026-10-29T11:00:00.000Z", NOW, "zh-CN")).toBe("不到 1 分钟");
  });
});

describe("guest share errors", () => {
  const t = (key: Parameters<typeof translateMoss>[1]) => translateMoss("en", key);

  it("finds the owner error code through nested causes", () => {
    const rpcError = new WsRpcError({
      message: "Sign in with a Moss account to share threads with guests.",
      code: "guest_share.account_required",
    });
    expect(readGuestShareErrorCode(rpcError)).toBe("guest_share.account_required");
    expect(readGuestShareErrorCode(new Error("wrapped", { cause: rpcError }))).toBe(
      "guest_share.account_required",
    );
    expect(readGuestShareErrorCode(new WsRpcError({ message: "x", code: "OTHER" }))).toBeNull();
    expect(readGuestShareErrorCode(null)).toBeNull();
  });

  it("localizes known codes and falls back to the error text or the generic line", () => {
    expect(
      describeGuestShareError(
        new WsRpcError({ message: "fallback", code: "guest_share.rate_limited" }),
        t,
      ),
    ).toEqual({
      code: "guest_share.rate_limited",
      message: translateMoss("en", "chat.guestShare.error.rateLimited"),
    });
    expect(describeGuestShareError(new Error("Socket closed"), t)).toEqual({
      code: null,
      message: "Socket closed",
    });
    expect(describeGuestShareError("boom", t)).toEqual({
      code: null,
      message: translateMoss("en", "chat.guestShare.error.generic"),
    });
  });
});
