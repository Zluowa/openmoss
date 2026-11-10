import { describe, expect, it } from "vitest";

import {
  localFilePathFromUrl,
  localFileUrlFromPath,
  normalizeBrowserUrlInput,
} from "./browserSession";

describe("local file URLs for the browser panel", () => {
  it("turns an absolute path into a file URL, encoding each segment", () => {
    expect(localFileUrlFromPath("C:\\Users\\me\\站点\\index.html")).toBe(
      "file:///C:/Users/me/%E7%AB%99%E7%82%B9/index.html",
    );
    expect(localFileUrlFromPath("d:/site/a b.html")).toBe("file:///D:/site/a%20b.html");
    expect(localFileUrlFromPath("\\\\nas\\share\\page.html")).toBe("file://nas/share/page.html");
    expect(localFileUrlFromPath("/home/me/page.html")).toBe("file:///home/me/page.html");
    expect(localFileUrlFromPath("site/index.html")).toBeNull();
  });

  it("reads the path back in the platform's own form", () => {
    expect(localFilePathFromUrl("file:///C:/Users/me/%E7%AB%99%E7%82%B9/index.html")).toBe(
      "C:\\Users\\me\\站点\\index.html",
    );
    expect(localFilePathFromUrl("file://nas/share/page.html")).toBe("\\\\nas\\share\\page.html");
    expect(localFilePathFromUrl("file:///home/me/page.html")).toBe("/home/me/page.html");
    expect(localFilePathFromUrl("https://example.com/")).toBeNull();
    expect(localFilePathFromUrl(null)).toBeNull();
  });

  it("opens a path typed into the address bar as that file", () => {
    expect(normalizeBrowserUrlInput("C:\\site\\index.html")).toBe("file:///C:/site/index.html");
    expect(normalizeBrowserUrlInput("localhost:5173")).toBe("http://localhost:5173/");
  });
});
