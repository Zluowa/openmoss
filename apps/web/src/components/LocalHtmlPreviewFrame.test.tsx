import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { LOCAL_HTML_PREVIEW_FRAME_SANDBOX, LocalHtmlPreviewFrame } from "./LocalHtmlPreviewFrame";

it("runs the file in an opaque sandbox with no Moss privileges", () => {
  const markup = renderToStaticMarkup(
    <LocalHtmlPreviewFrame
      src="http://127.0.0.1:5733/api/local-html/grant/index.html"
      title="index.html"
    />,
  );
  expect(LOCAL_HTML_PREVIEW_FRAME_SANDBOX).toBe("allow-scripts");
  expect(markup).toContain('sandbox="allow-scripts"');
  expect(markup).toMatch(/referrerpolicy="no-referrer"/iu);
  for (const privilege of [
    "allow-same-origin",
    "allow-forms",
    "allow-popups",
    "allow-modals",
    "allow-downloads",
    "allow-top-navigation",
    "allow-storage-access",
  ]) {
    expect(markup).not.toContain(privilege);
  }
  // No srcdoc: the document is never copied into Moss's own origin.
  expect(markup).not.toContain("srcdoc");
});
