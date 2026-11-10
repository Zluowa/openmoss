import { describe, expect, it } from "vitest";

import { readSpacePageHash, spacePageIdOfLink } from "./spacePageLink";

describe("space page links", () => {
  it("reads the item id from a chat link and from the hash", () => {
    expect(spacePageIdOfLink("moss://space-page/page_ab12-3")).toBe("page_ab12-3");
    expect(readSpacePageHash("#space-page=page_ab12-3")).toBe("page_ab12-3");
  });

  it("refuses anything that is not a plain item id", () => {
    expect(spacePageIdOfLink("moss://space-page/..%2Fsecret")).toBeNull();
    expect(spacePageIdOfLink("moss://thread/abc")).toBeNull();
    expect(spacePageIdOfLink(undefined)).toBeNull();
    expect(readSpacePageHash("#other=1")).toBeNull();
  });
});
