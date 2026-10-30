// FILE: HtmlRenderDocument.tsx
// Purpose: Back-compat export for the shared sandboxed agent document renderer.
// Layer: Chat UI
// Origin: HtmlRenderDocument from apps/web/src/components/files/BrowserDocumentFrame.tsx in
//   T3 Code (https://github.com/pingdotgg/t3code, MIT) at
//   ba0ea3d152150f399827d36a5b4b86c5bbda2d7f. See THIRD_PARTY_NOTICES.md.

import { SandboxedHtmlDocument } from "./SandboxedHtmlDocument";

/**
 * A sandboxed agent HTML render in the app theme. The page reads the theme from
 * its URL fragment before first paint, then follows changes posted to its
 * bootstrap. The first URL is kept for the frame's lifetime: a new src would
 * reload the page.
 */
export const HtmlRenderDocument = SandboxedHtmlDocument;
