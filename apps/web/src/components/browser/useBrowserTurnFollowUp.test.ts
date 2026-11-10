import { describe, expect, it } from "vitest";

import { browserTabShowsProjectWork } from "./useBrowserTurnFollowUp";
import { browserUrlForLocalHtmlFile } from "./browserPanelNavigation";

function tab(url: string) {
  return { url, lastCommittedUrl: url };
}

describe("browserTabShowsProjectWork", () => {
  it("counts pages under the project folder and local dev servers, nothing else", () => {
    const root = "D:\\work\\shop";
    expect(browserTabShowsProjectWork(tab("file:///D:/work/shop/pages/report.html"), root)).toBe(
      true,
    );
    expect(browserTabShowsProjectWork(tab("file:///D:/elsewhere/index.html"), root)).toBe(false);
    expect(browserTabShowsProjectWork(tab("http://localhost:5173/settings"), root)).toBe(true);
    expect(browserTabShowsProjectWork(tab("http://127.0.0.1:5941/"), root)).toBe(true);
    expect(browserTabShowsProjectWork(tab("https://example.com/"), root)).toBe(false);
    expect(browserTabShowsProjectWork(tab("about:blank"), root)).toBe(false);
  });
});

describe("browserUrlForLocalHtmlFile", () => {
  it("opens an HTML file given relative to the project or absolute", () => {
    expect(browserUrlForLocalHtmlFile("pages/report.html", "D:\\work\\shop")).toBe(
      "file:///D:/work/shop/pages/report.html",
    );
    expect(browserUrlForLocalHtmlFile("C:\\tmp\\index.htm", null)).toBe("file:///C:/tmp/index.htm");
    expect(browserUrlForLocalHtmlFile("src/app.ts", "D:\\work\\shop")).toBeNull();
    expect(browserUrlForLocalHtmlFile("pages/report.html", null)).toBeNull();
  });
});
