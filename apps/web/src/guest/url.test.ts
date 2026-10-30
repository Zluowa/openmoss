import { describe, expect, it } from "vitest";

import {
  clearStoredInvite,
  parseGuestLocation,
  parseInviteHash,
  parseShareId,
  readStoredInvite,
  takeGuestEntry,
  type InviteStorage,
} from "./url";

const SHARE_ID = "k3J9xQ2mT8vL5nR1pW7yZa";
const INVITE = `${SHARE_ID}.9f8e7d6c5b4a3210`;

function memoryStorage(): InviteStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function fakeWindow(pathname: string, hash: string, search = "") {
  const calls: string[] = [];
  return {
    calls,
    location: { pathname, hash, search },
    history: {
      state: null,
      replaceState: (_data: unknown, _unused: string, url?: string) => {
        calls.push(url ?? "");
      },
    },
  };
}

describe("parseShareId", () => {
  it("reads the id after /s/ and rejects anything else", () => {
    expect(parseShareId(`/s/${SHARE_ID}`)).toBe(SHARE_ID);
    expect(parseShareId(`/s/${SHARE_ID}/`)).toBe(SHARE_ID);
    expect(parseShareId("/s/")).toBeNull();
    expect(parseShareId("/s/with space")).toBeNull();
    expect(parseShareId("/s/a/b")).toBeNull();
    expect(parseShareId("/")).toBeNull();
    expect(parseShareId("/share/abc")).toBeNull();
  });
});

describe("parseInviteHash", () => {
  it("decodes the fragment and treats junk as no invite", () => {
    expect(parseInviteHash(`#${INVITE}`)).toBe(INVITE);
    expect(parseInviteHash(INVITE)).toBe(INVITE);
    expect(parseInviteHash("#%20")).toBeNull();
    expect(parseInviteHash("#%E0%A4%A")).toBeNull();
    expect(parseInviteHash("")).toBeNull();
    expect(parseInviteHash(`#${"x".repeat(300)}`)).toBeNull();
  });
});

describe("parseGuestLocation", () => {
  it("only pairs an invite with a share page", () => {
    expect(parseGuestLocation(`/s/${SHARE_ID}`, `#${INVITE}`)).toEqual({
      shareId: SHARE_ID,
      invite: INVITE,
    });
    expect(parseGuestLocation(`/s/${SHARE_ID}`, "")).toEqual({ shareId: SHARE_ID, invite: null });
    expect(parseGuestLocation("/other", `#${INVITE}`)).toEqual({ shareId: null, invite: null });
  });
});

describe("takeGuestEntry", () => {
  it("drops the fragment from the address bar and keeps the invite for this tab", () => {
    const storage = memoryStorage();
    const window = fakeWindow(`/s/${SHARE_ID}`, `#${INVITE}`, "?mock=live");
    expect(takeGuestEntry(window, storage)).toEqual({ shareId: SHARE_ID, invite: INVITE });
    expect(window.calls).toEqual([`/s/${SHARE_ID}?mock=live`]);
    expect(readStoredInvite(SHARE_ID, storage)).toBe(INVITE);
  });

  it("finds the stored invite after a reload without a fragment", () => {
    const storage = memoryStorage();
    takeGuestEntry(fakeWindow(`/s/${SHARE_ID}`, `#${INVITE}`), storage);
    const reload = fakeWindow(`/s/${SHARE_ID}`, "");
    expect(takeGuestEntry(reload, storage)).toEqual({ shareId: SHARE_ID, invite: INVITE });
    expect(reload.calls).toEqual([]);
  });

  it("forgets the invite once it is redeemed", () => {
    const storage = memoryStorage();
    takeGuestEntry(fakeWindow(`/s/${SHARE_ID}`, `#${INVITE}`), storage);
    clearStoredInvite(SHARE_ID, storage);
    expect(takeGuestEntry(fakeWindow(`/s/${SHARE_ID}`, ""), storage)).toEqual({
      shareId: SHARE_ID,
      invite: null,
    });
  });

  it("keeps invites apart per share and survives a throwing store", () => {
    const storage = memoryStorage();
    takeGuestEntry(fakeWindow(`/s/${SHARE_ID}`, `#${INVITE}`), storage);
    expect(readStoredInvite("other-share", storage)).toBeNull();
    const broken: InviteStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(takeGuestEntry(fakeWindow(`/s/${SHARE_ID}`, `#${INVITE}`), broken)).toEqual({
      shareId: SHARE_ID,
      invite: INVITE,
    });
  });
});
