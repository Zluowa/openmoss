import { describe, expect, it } from "vitest";

import { forgeRefLabel, linkTextIsForgeRef, parseForgeRef } from "./forgeRef";

describe("parseForgeRef", () => {
  it("reads pull requests, issues and pull request sub-pages", () => {
    expect(parseForgeRef("https://github.com/Zluowa/moss-synara/pull/360")).toEqual({
      owner: "Zluowa",
      repo: "moss-synara",
      kind: "pull",
      number: 360,
      detail: null,
    });
    expect(parseForgeRef("https://github.com/o/r/pull/7/files")?.detail).toBe("files");
    expect(parseForgeRef("https://github.com/o/r/issues/12")?.kind).toBe("issue");
    expect(parseForgeRef("https://github.com/o/r/tree/main")).toBeNull();
    expect(parseForgeRef("https://gitlab.com/o/r/pull/1")).toBeNull();
  });
});

describe("linkTextIsForgeRef", () => {
  const href = "https://github.com/Zluowa/moss-synara/pull/360";
  const ref = parseForgeRef(href)!;
  it("chips a bare URL or a plain reference, not descriptive text", () => {
    expect(forgeRefLabel(ref)).toBe("Zluowa/moss-synara#360");
    expect(linkTextIsForgeRef(href, href, ref)).toBe(true);
    expect(linkTextIsForgeRef("#360", href, ref)).toBe(true);
    expect(linkTextIsForgeRef("Zluowa/moss-synara#360", href, ref)).toBe(true);
    expect(linkTextIsForgeRef("#361", href, ref)).toBe(false);
    expect(linkTextIsForgeRef("the sign-in fix", href, ref)).toBe(false);
  });
});
