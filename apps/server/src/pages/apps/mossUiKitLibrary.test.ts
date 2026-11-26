// FILE: mossUiKitLibrary.test.ts
// Purpose: Verify Moss UI Kit classic and ESM bundling through Moss's local library pipeline
//          and ensure handbook / showcase fixtures prepare cleanly as offline-ready documents.
// Layer: Server app tests

import {
  buildMeetingRoomUiKitFixtureHtml,
  buildMossUiKitHandbookHtml,
  buildWechatReadUiKitFixtureHtml,
} from "@moss/shared/pageAppUiKitHandbook";
import { describe, expect, it } from "vitest";

import { readInlineVisualizationLibrary } from "../../inlineVisualizationAccess";
import { PAGE_APP_LOCAL_LIBRARIES, preparePageAppLibraries } from "./localLibraries";
import { PAGE_APP_LOCAL_MODULES } from "./localModuleLibraries";

const prepare = (html: string) =>
  preparePageAppLibraries(html, undefined, readInlineVisualizationLibrary);

describe("moss-ui-kit local library pipeline", () => {
  it("inlines the verified Moss UI Kit classic bundle with offlineReady: true", async () => {
    const classicUrl = PAGE_APP_LOCAL_LIBRARIES.find((item) => item.name === "Moss UI Kit")
      ?.urls[0];
    expect(classicUrl).toBeDefined();
    const html = `<!doctype html><html><head><script src="${classicUrl}"></script></head><body><moss-companion-drawer></moss-companion-drawer></body></html>`;
    const result = await prepare(html);
    expect(result.offlineReady).toBe(true);
    expect(result.html).toContain('data-moss-local-library="Moss UI Kit@1.0.0"');
    expect(result.html).not.toContain('src="https:');
  });

  it("wires bare 'moss-ui-kit' and pinned +esm imports via the local module import map", async () => {
    const bareHtml =
      '<!doctype html><html><head></head><body><script type="module">import { MossSelectionAsk } from "moss-ui-kit";console.log(Boolean(MossSelectionAsk));</script></body></html>';
    const bareResult = await prepare(bareHtml);
    expect(bareResult.offlineReady).toBe(true);
    expect(bareResult.html).toContain("data-moss-local-modules");
    expect(bareResult.html).toContain("moss-selection-ask");

    const cdnUrl = PAGE_APP_LOCAL_MODULES.find((item) => item.asset === "moss-ui-kit.esm.js")
      ?.urls[1];
    expect(cdnUrl).toBeDefined();
    const cdnHtml = `<!doctype html><html><head></head><body><script type="module">import { registerMossUIKit } from "${cdnUrl}";registerMossUIKit();</script></body></html>`;
    const cdnResult = await prepare(cdnHtml);
    expect(cdnResult.offlineReady).toBe(true);
    expect(cdnResult.html).toContain("data-moss-local-modules");
  });

  it("refuses unverified versions or tampered UI kit bytes", async () => {
    const badVersion =
      '<script src="https://cdn.jsdelivr.net/npm/@moss/ui-kit@2.0.0/dist/moss-ui-kit.umd.js"></script>';
    expect(await prepare(badVersion)).toEqual({ html: badVersion, offlineReady: false });

    const classicUrl = PAGE_APP_LOCAL_LIBRARIES.find((item) => item.name === "Moss UI Kit")
      ?.urls[0];
    const html = `<script src="${classicUrl}"></script>`;
    const tampered = await preparePageAppLibraries(html, undefined, async () => ({
      contents: new TextEncoder().encode("tampered ui kit"),
      contentType: "text/javascript",
    }));
    expect(tampered).toEqual({ html, offlineReady: false });
  });

  it("prepares the handbook, WeChat Read fixture, and Meeting Room fixture offline-ready", async () => {
    for (const html of [
      buildMossUiKitHandbookHtml(),
      buildWechatReadUiKitFixtureHtml(),
      buildMeetingRoomUiKitFixtureHtml(),
    ]) {
      const result = await prepare(html);
      expect(result.offlineReady).toBe(true);
      expect(result.html).toContain("data-moss-local-modules");
    }
  });
});
