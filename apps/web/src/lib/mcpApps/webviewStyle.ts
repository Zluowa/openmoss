// FILE: webviewStyle.ts
// Purpose: How a widget's <webview> is styled. Electron sizes the guest page from the
//          element's internal frame, and that frame fills the element only under display:flex
//          (BrowserPanel does the same); with display:block every guest stays 150 px tall.
// Layer: MCP App host (web); also used by the desktop sandbox e2e fixture
// Exports: MCP_APP_WEBVIEW_DISPLAY, styleMcpAppWebview

export const MCP_APP_WEBVIEW_DISPLAY = "flex" as const;

/** Displayed, filling its wrapper, no border. */
export function styleMcpAppWebview(webview: HTMLElement): void {
  webview.style.display = MCP_APP_WEBVIEW_DISPLAY;
  webview.style.width = "100%";
  webview.style.height = "100%";
  webview.style.border = "0";
}
