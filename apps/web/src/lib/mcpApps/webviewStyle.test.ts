import { describe, expect, it } from "vitest";

import { styleMcpAppWebview } from "./webviewStyle";

describe("styleMcpAppWebview", () => {
  it("displays the webview as flex so Electron sizes the guest to the element", () => {
    const webview = { style: {} as Record<string, string> } as unknown as HTMLElement;
    styleMcpAppWebview(webview);
    expect(webview.style).toMatchObject({
      display: "flex",
      width: "100%",
      height: "100%",
      border: "0",
    });
  });
});
