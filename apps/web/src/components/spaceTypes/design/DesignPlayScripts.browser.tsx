// FILE: DesignPlayScripts.browser.tsx
// Purpose: L-023. A 设计 artboard played under the app's own content security policy (the exact
//          policy of index.html, put on this page) runs its own script, follows a `board:` link
//          and shows its script errors, as it does in Moss. The playing frame is an opaque origin
//          the test cannot read, so what it paints is read from a screenshot.
// Layer: Browser tests (headless Chromium)

import "../../../index.css";

import { parseDesignCanvas, type DesignCanvas } from "@moss/shared/spaceItems/designCanvas";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import shellIndexHtml from "../../../../index.html?raw";
import { captureViewportPixels, colorShare, PROBE_CSS_COLOR } from "../../../test/themeHookPaint";
import { DesignPlayer } from "./DesignPlayer";

const SHELL_POLICY =
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(shellIndexHtml)?.[1] ??
  "";

const canvas: DesignCanvas = parseDesignCanvas({
  version: 1,
  pages: [{ id: "page-1", name: "页面 1" }],
  boards: [
    {
      id: "home",
      name: "首页",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      interactive: true,
      // The artboard's script paints it; the link covers it, so a click anywhere follows it.
      html: `<div id="stage" style="width: 400px; height: 300px; background: rgb(255, 255, 255)"><a href="board:next" style="display: block; width: 400px; height: 300px">下一页</a></div><script>document.getElementById("stage").style.background = "${PROBE_CSS_COLOR}";</script>`,
    },
    {
      id: "next",
      name: "第二页",
      x: 480,
      y: 0,
      w: 400,
      h: 300,
      html: '<div style="width: 400px; height: 300px"><p>第二页</p></div><script>setTimeout(function () { throw new Error("第二页的脚本"); }, 0);</script>',
    },
  ],
});

function Player() {
  const [boardId, setBoardId] = useState("home");
  return <DesignPlayer canvas={canvas} boardId={boardId} onBoard={setBoardId} onClose={() => {}} />;
}

const playerFrame = () => document.querySelector<HTMLIFrameElement>("[data-design-player] iframe");

/** Share of the playing artboard that shows the colour its own script paints. */
async function paintedShare(): Promise<number> {
  const frame = playerFrame();
  if (!frame) return 0;
  const rect = frame.getBoundingClientRect();
  const pixels = await captureViewportPixels();
  // The middle of the artboard, clear of the link's words in its corner.
  return colorShare(pixels, {
    left: rect.left + rect.width * 0.25,
    top: rect.top + rect.height * 0.4,
    width: rect.width * 0.5,
    height: rect.height * 0.4,
  });
}

let mounted: { unmount: () => void } | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("L-023: a played 设计 artboard under the app's content security policy", () => {
  beforeAll(() => {
    expect(SHELL_POLICY).toContain("script-src 'self'");
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = SHELL_POLICY;
    document.head.prepend(meta);
    // The page is now under the shell's policy: an inline script of its own does not run.
    const probe = document.createElement("script");
    probe.textContent = "window.__l023Probe = true;";
    document.head.append(probe);
    expect((window as { __l023Probe?: boolean }).__l023Probe).toBeUndefined();
  });

  it("runs the artboard's own script, follows its board link and shows its script error", async () => {
    mounted = await render(<Player />);
    await expect.poll(playerFrame).not.toBeNull();
    await expect.element(page.getByText("1 / 2", { exact: true })).toBeVisible();

    // The artboard's own script painted it.
    await expect.poll(paintedShare, { interval: 250, timeout: 15_000 }).toBeGreaterThan(0.9);

    // A click on its `board:` link moves to that artboard.
    await page.elementLocator(playerFrame()!).click();
    await expect.element(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await expect.element(page.getByText("第二页", { exact: true })).toBeVisible();

    // That artboard's script throws, and the player says so.
    await expect.element(page.getByRole("alert")).toHaveTextContent("这个画板的脚本出错了");
    await expect.element(page.getByRole("alert")).toHaveTextContent("第二页的脚本");
  });
});
