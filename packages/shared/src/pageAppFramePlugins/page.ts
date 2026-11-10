// FILE: page.ts
// Purpose: Frame half of the `page` capability: read this 应用页's metadata
// and publish a new version of it (editors only).
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const pageFramePlugin: PageAppFramePlugin = {
  name: "page",
  frameSource: String.raw`function (bridge) {
  return {
    metadata: function () { return bridge.call("metadata", null); },
    publish: function (html) {
      if (typeof html !== "string" || !html.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "publish() takes the full HTML of the page."));
      }
      return bridge.call("publish", { html: html });
    },
  };
}`,
};
