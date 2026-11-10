import { describe, expect, it } from "vitest";

import { decideLinkEntry, descendantPageIds, effectiveLinkSetting } from "./pageShareAccess.ts";
import {
  isLinkCredential,
  isSiteCredential,
  linkCredential,
  memberCredential,
  parseMemberCredential,
  siteCredential,
} from "./pageShareCredentials.ts";

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const otherKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const LINK = "AAAAAAAAAAAAAAAAAAAAAA";

describe("effectiveLinkSetting", () => {
  it("uses the space when the page has no setting, and the default without either", () => {
    expect(effectiveLinkSetting(null, null)).toEqual({ access: "invited", role: "view" });
    expect(effectiveLinkSetting(null, { access: "link", role: "comment" })).toEqual({
      access: "link",
      role: "comment",
    });
  });

  it("lets a page open up but never close down", () => {
    const space = { access: "link", role: "comment" } as const;
    expect(effectiveLinkSetting({ access: "anyone", role: "view" }, space)).toEqual({
      access: "anyone",
      role: "comment",
    });
    expect(effectiveLinkSetting({ access: "invited", role: "edit" }, space)).toEqual({
      access: "link",
      role: "comment",
    });
    // An invited-only space adds nothing to a page's own link.
    expect(
      effectiveLinkSetting({ access: "link", role: "view" }, { access: "invited", role: "edit" }),
    ).toEqual({ access: "link", role: "view" });
  });
});

describe("decideLinkEntry", () => {
  it("needs the link credential only for link access", () => {
    expect(decideLinkEntry({ access: "anyone", role: "view" }, null)).toEqual({
      ok: true,
      role: "view",
    });
    expect(decideLinkEntry({ access: "link", role: "edit" }, true)).toEqual({
      ok: true,
      role: "edit",
    });
    expect(decideLinkEntry({ access: "link", role: "edit" }, false)).toMatchObject({
      reason: "forbidden",
    });
    expect(decideLinkEntry({ access: "link", role: "edit" }, null)).toMatchObject({
      reason: "invite-only",
    });
    expect(decideLinkEntry({ access: "invited", role: "edit" }, true)).toMatchObject({
      reason: "invite-only",
    });
  });
});

describe("descendantPageIds", () => {
  it("follows parents and survives cycles", () => {
    const pages = [
      { id: "a", parentPageId: null },
      { id: "b", parentPageId: "a" },
      { id: "c", parentPageId: "b" },
      { id: "d", parentPageId: null },
      { id: "x", parentPageId: "y" },
      { id: "y", parentPageId: "x" },
    ];
    expect([...descendantPageIds("b", pages)].toSorted()).toEqual(["b", "c"]);
    expect([...descendantPageIds("x", pages)].toSorted()).toEqual(["x", "y"]);
  });
});

describe("credentials", () => {
  it("keeps each kind and each key apart", () => {
    const link = linkCredential(key, LINK);
    expect(isLinkCredential(key, LINK, link)).toBe(true);
    expect(isLinkCredential(otherKey, LINK, link)).toBe(false);
    expect(isLinkCredential(key, "BAAAAAAAAAAAAAAAAAAAAA", link)).toBe(false);
    expect(isSiteCredential(key, LINK, link)).toBe(false);
    expect(isSiteCredential(key, LINK, siteCredential(key, LINK))).toBe(true);
    const member = memberCredential(key, "member-0001");
    expect(parseMemberCredential(key, member)).toBe("member-0001");
    expect(parseMemberCredential(otherKey, member)).toBeNull();
    expect(parseMemberCredential(key, `${member}.extra`)).toBeNull();
    expect(parseMemberCredential(key, link)).toBeNull();
  });
});
