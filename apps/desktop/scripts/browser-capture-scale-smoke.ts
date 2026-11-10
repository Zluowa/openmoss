// Exercises real Chromium screenshots of the browser panel at 150% display scaling.
// A page that navigates while its native view is out of the window keeps a device
// scale of 1 in its widget, and capturePage then returns a magnified top-left crop.
// Uses an isolated Electron profile and synthetic pages through DesktopBrowserManager.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage } from "electron";
import { ThreadId } from "@moss/contracts";
import { captureBrowserScreenshot } from "../src/browserAutomation/screenshotCapture";
import { DesktopBrowserManager } from "../src/browserManager";

const SCALE = 1.5;
app.commandLine.appendSwitch("force-device-scale-factor", String(SCALE));
// The window sits off-screen and unfocused; keep Windows from treating it as occluded.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
const home = mkdtempSync(join(tmpdir(), "moss-browser-capture-scale-"));
app.setPath("userData", home);
const deadline = setTimeout(() => app.exit(1), 60_000);

// Corner squares make a magnified crop obvious: the bottom-right one leaves the frame.
// Served from loopback: the panel turns a data: URL into a web search.
const PAGE_HTML =
  `<style>html,body{margin:0;height:100%;background:#fff}i{position:fixed;width:40px;height:40px}</style>` +
  `<i style="left:0;top:0;background:#0000ff"></i><i style="right:0;bottom:0;background:#ff00ff"></i>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(PAGE_HTML);
});

const pixel = (png: Buffer, x: number, y: number) => {
  const image = nativeImage.createFromBuffer(png);
  const { width } = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const offset = (y * width + x) * 4;
  return { r: bitmap[offset + 2]!, g: bitmap[offset + 1]!, b: bitmap[offset]! };
};

const assertUnmagnified = (label: string, png: Buffer, viewport: { w: number; h: number }) => {
  const { width, height } = nativeImage.createFromBuffer(png).getSize();
  assert.deepEqual(
    { width, height },
    { width: Math.round(viewport.w * SCALE), height: Math.round(viewport.h * SCALE) },
    `${label}: size`,
  );
  // 20 CSS px in from the bottom-right corner is inside the magenta square.
  const inset = Math.round(20 * SCALE);
  const corner = pixel(png, width - inset, height - inset);
  assert.ok(
    corner.r > 200 && corner.g < 60 && corner.b > 200,
    `${label}: bottom-right corner is ${JSON.stringify(corner)}, expected magenta (magnified crop)`,
  );
};

async function smoke(): Promise<void> {
  await app.whenReady();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const window = new BrowserWindow({
    x: -4000,
    y: 0,
    width: 1000,
    height: 760,
    show: false,
    focusable: false,
    skipTaskbar: true,
  });
  window.showInactive();
  const manager = new DesktopBrowserManager();
  manager.setWindow(window);
  const threadId = ThreadId.makeUnsafe("capture-scale-smoke");
  const bounds = { x: 100, y: 50, width: 415, height: 603 };
  const show = () => manager.setPanelBounds({ threadId, surface: "native", bounds });
  try {
    const state = manager.open({ threadId });
    const tabId = state.activeTabId!;
    show();
    const { webContents } = manager.getVisibleAutomationRuntime({ threadId, tabId });
    const loaded = () =>
      new Promise<void>((resolve) => webContents.once("did-stop-loading", () => resolve()));
    let load = loaded();
    manager.navigate({ threadId, tabId, url: `${origin}/first` });
    await load;

    // Hide the panel (as a covering menu or the address bar's suggestions do),
    // navigate while hidden, then show the page again.
    manager.setPanelBounds({ threadId, surface: "native", bounds: null, occluded: false });
    load = loaded();
    manager.navigate({ threadId, tabId, url: `${origin}/second` });
    await load;
    show();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const viewport = (await webContents.executeJavaScript("({w:innerWidth,h:innerHeight})")) as {
      w: number;
      h: number;
    };

    // Not asserted: a later Electron may fix capturePage itself.
    const raw = await webContents.capturePage().then(
      (image) => image.toPNG(),
      (error: unknown) => String(error),
    );
    console.log(
      "raw capturePage after hidden navigation:",
      typeof raw === "string"
        ? raw
        : pixel(raw, Math.round(viewport.w * SCALE) - 30, Math.round(viewport.h * SCALE) - 30),
    );

    const copied = Buffer.from((await manager.captureScreenshot({ threadId, tabId })).bytes);
    assertUnmagnified("panel screenshot", copied, viewport);
    const agent = await captureBrowserScreenshot(
      manager.getVisibleAutomationRuntime({ threadId, tabId }),
      { fullPage: false },
    );
    assertUnmagnified("agent screenshot", Buffer.from(agent.image.data, "base64"), viewport);
  } finally {
    manager.dispose();
    window.destroy();
    server.close();
  }
}

smoke()
  .then(() => {
    clearTimeout(deadline);
    console.log("browser capture scale smoke passed");
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows keeps the live profile locked until exit; the OS temp cleanup takes it.
    }
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
