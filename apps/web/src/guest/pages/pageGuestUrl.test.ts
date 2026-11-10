import { describe, expect, it } from "vitest";

import { parsePageGuestLocation, pageVisitorId, takePageGuestEntry } from "./pageGuestUrl";

const SHARE = "AbCdEfGhIjKlMnOpQrStUv";
const LINK = "LinkLinkLinkLinkLink12";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}

describe("parsePageGuestLocation", () => {
  it("reads the publisher, the link and the fragment credential", () => {
    expect(parsePageGuestLocation(`/p/${SHARE}`, `?l=${LINK}`, "#l.abc")).toEqual({
      shareId: SHARE,
      link: LINK,
      key: "l.abc",
    });
    expect(parsePageGuestLocation(`/p/${SHARE}/`, "", "#m.member.sig")).toEqual({
      shareId: SHARE,
      link: null,
      key: "m.member.sig",
    });
  });

  it("rejects other paths and malformed parts", () => {
    expect(parsePageGuestLocation(`/s/${SHARE}`, "", "")).toBeNull();
    expect(parsePageGuestLocation("/p/short", "", "")).toBeNull();
    expect(parsePageGuestLocation(`/p/${SHARE}`, "?l=bad", "#%E0%A4%A")).toEqual({
      shareId: SHARE,
      link: null,
      key: null,
    });
  });
});

describe("takePageGuestEntry", () => {
  it("drops the credential from the address bar and remembers it for the next visit", () => {
    const storage = memoryStorage();
    const replaced: string[] = [];
    const win = {
      location: { pathname: `/p/${SHARE}`, search: `?l=${LINK}`, hash: "#l.secret" },
      history: { replaceState: (_: unknown, __: string, url: string) => void replaced.push(url) },
    } as unknown as Window;
    expect(takePageGuestEntry(win, storage)?.key).toBe("l.secret");
    expect(replaced).toEqual([`/p/${SHARE}?l=${LINK}`]);

    const returning = {
      location: { pathname: `/p/${SHARE}`, search: `?l=${LINK}`, hash: "" },
      history: win.history,
    } as unknown as Window;
    expect(takePageGuestEntry(returning, storage)?.key).toBe("l.secret");
  });
});

describe("pageVisitorId", () => {
  it("is stable per browser", () => {
    const storage = memoryStorage();
    const first = pageVisitorId(storage);
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(pageVisitorId(storage)).toBe(first);
  });
});
