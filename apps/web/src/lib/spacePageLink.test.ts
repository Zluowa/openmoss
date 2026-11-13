import { describe, expect, it } from "vitest";

import {
  readSpacePageHash,
  rememberStartSlide,
  spacePageIdOfLink,
  spacePageSlideLink,
  spacePageSlideOfLink,
  takeStartSlide,
} from "./spacePageLink";

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
  it("carries a slide number for 拷贝幻灯片链接 and hands it to the deck once", () => {
    const link = spacePageSlideLink("page_ab12-3", 7);
    expect(link).toBe("moss://space-page/page_ab12-3#slide-7");
    expect(spacePageIdOfLink(link)).toBe("page_ab12-3");
    expect(spacePageSlideOfLink(link)).toBe(7);
    expect(spacePageSlideOfLink("moss://space-page/page_ab12-3")).toBeNull();
    expect(spacePageSlideOfLink("moss://space-page/page_ab12-3#slide-0")).toBeNull();
    rememberStartSlide("page_ab12-3", 7);
    expect(takeStartSlide("page_ab12-3")).toBe(7);
    expect(takeStartSlide("page_ab12-3")).toBeNull();
  });
});
