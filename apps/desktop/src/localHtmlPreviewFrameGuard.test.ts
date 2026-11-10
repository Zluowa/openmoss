import { describe, expect, it } from "vitest";

import {
  localHtmlPreviewGrantScope,
  shouldBlockLocalHtmlPreviewFrameNavigation,
  shouldDenyLocalHtmlPreviewWindowOpen,
} from "./localHtmlPreviewFrameGuard";

const backend = "http://127.0.0.1:5733";
const preview = `${backend}/api/local-html/grant-a/index.html`;
const app = "moss://app/index.html";

describe("localHtmlPreviewGrantScope", () => {
  it("reduces a preview URL to its grant folder", () => {
    expect(localHtmlPreviewGrantScope(`${preview}?x=1#top`)).toBe(
      `${backend}/api/local-html/grant-a/`,
    );
    expect(localHtmlPreviewGrantScope(`${backend}/api/local-html/grant-a/sub/page.html`)).toBe(
      `${backend}/api/local-html/grant-a/`,
    );
  });

  it.each([
    null,
    undefined,
    "",
    "about:blank",
    app,
    `${backend}/api/local-image?path=x`,
    `${backend}/api/local-html/`,
    `${backend}/api/local-html//index.html`,
    "http://user:pass@127.0.0.1:5733/api/local-html/grant-a/index.html",
    "file:///api/local-html/grant-a/index.html",
    "not a url",
  ])("is not a preview: %s", (value) => {
    expect(localHtmlPreviewGrantScope(value)).toBeNull();
  });
});

describe("shouldBlockLocalHtmlPreviewFrameNavigation", () => {
  const navigate = (frameChainUrls: (string | null)[], targetUrl: string, isMainFrame = false) =>
    shouldBlockLocalHtmlPreviewFrameNavigation({ isMainFrame, frameChainUrls, targetUrl });

  it("blocks a preview frame leaving its grant, whatever the destination", () => {
    for (const target of [
      "https://attacker.example/collect?data=secret",
      "http://127.0.0.1:9999/",
      `${backend}/api/local-html/grant-b/index.html`,
      `${backend}/api/local-image?path=C:/secret.png`,
      "data:text/html,<script>1</script>",
      "javascript:alert(1)",
      "about:blank",
      "file:///C:/Users/me/secret.html",
    ]) {
      expect(navigate([preview, app], target), target).toBe(true);
    }
  });

  it("lets the preview move between pages of its own folder", () => {
    expect(navigate([preview, app], `${backend}/api/local-html/grant-a/about.html`)).toBe(false);
    expect(navigate([preview, app], `${backend}/api/local-html/grant-a/docs/a.html#x`)).toBe(false);
  });

  it("guards frames nested inside a preview", () => {
    expect(navigate(["about:blank", preview, app], "https://attacker.example/")).toBe(true);
  });

  it("leaves the app and other frames alone", () => {
    // Moss loading the preview into a fresh iframe.
    expect(navigate(["about:blank", app], preview)).toBe(false);
    expect(navigate([`${backend}/other`, app], "https://example.com/")).toBe(false);
    expect(navigate([app], "https://example.com/", true)).toBe(false);
    expect(navigate([null, app], "https://example.com/")).toBe(false);
  });
});

describe("shouldDenyLocalHtmlPreviewWindowOpen", () => {
  it("refuses windows that open or come from a preview", () => {
    expect(shouldDenyLocalHtmlPreviewWindowOpen({ url: preview })).toBe(true);
    expect(
      shouldDenyLocalHtmlPreviewWindowOpen({ url: "https://example.com", referrerUrl: preview }),
    ).toBe(true);
    expect(
      shouldDenyLocalHtmlPreviewWindowOpen({ url: "https://example.com", referrerUrl: "" }),
    ).toBe(false);
  });
});
