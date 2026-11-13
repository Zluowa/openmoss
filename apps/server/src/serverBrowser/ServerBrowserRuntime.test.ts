import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserHostRpcError } from "../browserAutomation/browserHostRpcClient.ts";

import { ServerBrowserRuntime } from "./ServerBrowserRuntime.ts";
import { ServerBrowserViewerHub } from "./ServerBrowserViewers.ts";
import { isServerBrowserNavigable } from "./serverBrowserNavigationGuard.ts";

import { readdirSync } from "node:fs";

/**
 * A Chromium to drive: an explicit one, Playwright's own, or any Playwright
 * build in its browsers directory. Absent everywhere, the suite skips.
 */
const chromiumPath = await (async () => {
  const explicit = process.env.MOSS_TEST_CHROMIUM?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  try {
    // The headless shell first: it is what the server ships and launches.
    for (const entry of readdirSync(root).filter((name) =>
      /^chromium_headless_shell-\d+$/u.test(name),
    )) {
      const candidate = join(root, entry, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(candidate)) return candidate;
    }
    for (const entry of readdirSync(root).filter((name) => /^chromium-\d+$/u.test(name))) {
      const candidate = join(root, entry, "chrome-linux64", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No browsers directory.
  }
  const own = await import("playwright")
    .then(({ chromium }) => chromium.executablePath())
    .catch(() => "");
  return own && existsSync(own) ? own : "";
})();
const hasChromium = chromiumPath !== "";

const PAGE = `<!doctype html><title>Start</title>
<button id="go" style="position:absolute;left:20px;top:20px;width:200px;height:60px"
  onclick="document.title='clicked'">Go</button>
<script>console.log("hello from the page")</script>`;

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof BrowserHostRpcError)) return undefined;
  return (error.data as { error?: { code?: string } } | undefined)?.error?.code;
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return "resolved";
  } catch (error) {
    return errorCode(error) ?? String(error);
  }
}

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 5_000) => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe.skipIf(!hasChromium)("ServerBrowserRuntime with headless Chromium", () => {
  let server: Server;
  let origin: string;
  let home: string;
  let runtime: ServerBrowserRuntime;
  let scriptCalls: Array<{ code: string; cdpUrl: string }>;
  let scriptGate: Promise<void> | null;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    home = await mkdtemp(join(tmpdir(), "moss-server-browser-"));
    scriptCalls = [];
    scriptGate = null;
    runtime = new ServerBrowserRuntime({
      betterwrightHome: home,
      resolveExecutable: async () => chromiumPath,
      // The fixture is on loopback, which the server browser otherwise refuses.
      navigationGuard: async (url) => url.origin === origin,
      runScript: async ({ code, cdpUrl, signal }) => {
        scriptCalls.push({ code, cdpUrl });
        if (scriptGate) {
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            void scriptGate!.then(resolve);
          });
        }
        return { ok: true, code };
      },
    });
  });

  afterAll(async () => {
    await runtime.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown> = {}, threadId = "thread-a") =>
    runtime.execute({ threadId, name: name as never, arguments: args, timeoutMs: 15_000 });

  it("opens, lists, navigates, screenshots and reads logs of a thread's tab", async () => {
    const status = (await call("browser_status")) as Record<string, unknown>;
    expect(status).toMatchObject({ available: true, physicalScope: "server-headless-chromium" });

    const opened = (await call("browser_open", { url: `${origin}/redirect` })) as {
      tabId: string;
      finalUrl: string;
      redirects: string[];
      disposition: string;
    };
    expect(opened.disposition).toBe("created");
    expect(opened.finalUrl).toBe(`${origin}/`);
    expect(opened.redirects).toEqual([`${origin}/redirect`]);

    const reused = (await call("browser_open", {})) as { tabId: string; disposition: string };
    expect(reused).toMatchObject({ tabId: opened.tabId, disposition: "reused" });

    const tabs = (await call("browser_tabs")) as {
      tabs: Array<{ tabId: string; url: string; title: string }>;
      assignedTabId: string;
    };
    expect(tabs.assignedTabId).toBe(opened.tabId);
    expect(tabs.tabs).toHaveLength(1);
    await waitFor(async () => {
      const latest = (await call("browser_tabs")) as { tabs: Array<{ title: string }> };
      return latest.tabs[0]?.title === "Start";
    });

    const shot = (await call("browser_screenshot")) as {
      structuredContent: { image: { width: number; height: number }; mode: string };
      image: { data: string; mimeType: string };
    };
    expect(shot.structuredContent).toMatchObject({
      mode: "viewport",
      image: { width: 1280, height: 800 },
    });
    expect(shot.image.mimeType).toBe("image/png");
    expect(Buffer.from(shot.image.data, "base64").subarray(1, 4).toString()).toBe("PNG");

    const logs = (await call("browser_logs")) as {
      entries: Array<{ kind: string; text?: string }>;
    };
    expect(
      logs.entries.some(
        (entry) => entry.kind === "console" && entry.text === "hello from the page",
      ),
    ).toBe(true);
    expect(logs.entries.some((entry) => entry.kind === "network")).toBe(true);

    const resized = (await call("browser_resize", { width: 800, height: 600 })) as {
      observed: { width: number; height: number };
    };
    expect(resized.observed).toMatchObject({ width: 800, height: 600 });

    expect(await codeOf(call("browser_navigate", { url: "file:///etc/passwd" }))).toBe(
      "BrowserNavigationBlocked",
    );
    expect(await codeOf(call("browser_navigate", { url: origin }, "thread-without-browser"))).toBe(
      "BrowserTabNotFound",
    );
  });

  it("refuses the agent while a person controls the tab, then tells it once control returns", async () => {
    const opened = (await call("browser_open", { url: origin }, "thread-b")) as { tabId: string };
    const tab = runtime.thread("thread-b")!.tabs.get(opened.tabId)!;
    await tab.control.take("viewer-1");
    expect(await codeOf(call("browser_navigate", { url: `${origin}/x` }, "thread-b"))).toBe(
      "BrowserInterruptedByHuman",
    );
    // Reads still work while the person drives.
    expect(await codeOf(call("browser_screenshot", {}, "thread-b"))).toBe("resolved");
    expect(runtime.consumeHandoffNotice("thread-b")).toBeUndefined();
    await tab.control.release("viewer-1");
    expect(runtime.consumeHandoffNotice("thread-b")).toContain("has released it");
    expect(runtime.consumeHandoffNotice("thread-b")).toBeUndefined();
    expect(await codeOf(call("browser_navigate", { url: `${origin}/y` }, "thread-b"))).toBe(
      "resolved",
    );
  });

  it("runs scripts against the thread's own browser and aborts one when a person takes over", async () => {
    const opened = (await call("browser_open", { url: origin }, "thread-c")) as { tabId: string };
    const run = (await call("browser_run", { code: "return 1" }, "thread-c")) as {
      tabId: string;
      value: unknown;
      serializedByteCount: number;
    };
    expect(run).toMatchObject({ tabId: opened.tabId, value: { ok: true } });
    expect(scriptCalls.at(-1)?.code).toContain(opened.tabId);
    expect(scriptCalls.at(-1)?.code.endsWith("return 1")).toBe(true);
    expect(scriptCalls.at(-1)?.cdpUrl).toBe(runtime.thread("thread-c")!.cdpUrl);
    expect(runtime.thread("thread-c")!.cdpUrl).not.toBe(runtime.thread("thread-a")!.cdpUrl);

    let release!: () => void;
    scriptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = call("browser_run", { code: "long" }, "thread-c");
    const tab = runtime.thread("thread-c")!.tabs.get(opened.tabId)!;
    await waitFor(() => tab.agentAbort !== null);
    runtime.interruptAgent(tab);
    await tab.control.take("viewer-2");
    expect(await codeOf(running)).toBe("BrowserInterruptedByHuman");
    release();
    scriptGate = null;
    await tab.control.release("viewer-2");
  });

  it("streams frames to a viewer and dispatches its input only after it takes control", async () => {
    const hub = new ServerBrowserViewerHub(runtime);
    const opened = (await call("browser_open", { url: origin }, "thread-d")) as { tabId: string };
    const texts: Array<Record<string, unknown>> = [];
    const frames: Uint8Array[] = [];
    const handle = hub.attach(
      "thread-d",
      {
        sendBinary: (data) => frames.push(data),
        sendText: (text) => texts.push(JSON.parse(text) as Record<string, unknown>),
        backlogBytes: () => 0,
        close: () => {},
      },
      { maxWidth: 1280, maxHeight: 800, quality: 60, canOperate: true },
    );
    try {
      await waitFor(() => frames.length > 0);
      expect(frames[0]![0]).toBe(0xff); // JPEG SOI
      expect(texts.find((message) => message.type === "tabs")).toMatchObject({
        selectedTabId: opened.tabId,
      });
      expect(texts.find((message) => message.type === "viewport")).toMatchObject({ width: 1280 });
      await waitFor(() =>
        texts.some((message) => message.type === "control" && message.controller === "agent"),
      );

      const tab = runtime.thread("thread-d")!.tabs.get(opened.tabId)!;
      const click = (action: "down" | "up") =>
        handle.receive(
          JSON.stringify({
            type: "mouse",
            action,
            x: 100,
            y: 50,
            button: "left",
            buttons: action === "down" ? 1 : 0,
            clickCount: 1,
            modifiers: 0,
          }),
        );
      // Input from a viewer that has not taken control is ignored.
      click("down");
      click("up");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await tab.page.title()).toBe("Start");

      handle.receive(JSON.stringify({ type: "takeControl" }));
      await waitFor(() =>
        texts.some((message) => message.type === "control" && message.controller === "you"),
      );
      expect(await codeOf(call("browser_reload", {}, "thread-d"))).toBe(
        "BrowserInterruptedByHuman",
      );
      click("down");
      click("up");
      await waitFor(async () => (await tab.page.title()) === "clicked");

      // A watching viewer sizes the page to its panel, until the agent pins it.
      handle.receive(JSON.stringify({ type: "resize", width: 700, height: 500 }));
      await waitFor(() => tab.page.viewportSize()?.width === 700);
      expect(texts.some((m) => m.type === "viewport" && m.width === 700 && m.height === 500)).toBe(
        true,
      );
      await tab.control.release(tab.control.controller!);
      await call("browser_resize", { width: 900, height: 600 }, "thread-d");
      handle.receive(JSON.stringify({ type: "resize", width: 640, height: 480 }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(tab.page.viewportSize()).toMatchObject({ width: 900, height: 600 });
      handle.receive(JSON.stringify({ type: "takeControl" }));
      await waitFor(() => tab.control.controller !== null);

      handle.receive(JSON.stringify({ type: "ack" }));
      handle.receive(JSON.stringify({ type: "releaseControl" }));
      await waitFor(() => tab.control.controller === null);
      expect(runtime.consumeHandoffNotice("thread-d")).toContain("has released it");
    } finally {
      await handle.detach();
    }
  });

  it("closes a tab and reports the next active one", async () => {
    const first = (await call("browser_open", { url: origin }, "thread-e")) as { tabId: string };
    const second = (await call("browser_open", { url: origin, reuse: false }, "thread-e")) as {
      tabId: string;
    };
    expect(second.tabId).not.toBe(first.tabId);
    const closed = (await call("browser_close", {}, "thread-e")) as {
      closedTabId: string;
      activeTabId: string | null;
    };
    expect(closed).toEqual({ closedTabId: second.tabId, activeTabId: first.tabId });
  });
});

describe.skipIf(!hasChromium)("ServerBrowserRuntime browser_run with Betterwright", () => {
  it("runs a real Betterwright script against the thread's tab", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const home = await mkdtemp(join(tmpdir(), "moss-server-browser-bw-"));
    const runtime = new ServerBrowserRuntime({
      betterwrightHome: home,
      resolveExecutable: async () => chromiumPath,
      navigationGuard: async (url) => url.origin === origin,
    });
    try {
      const execute = (name: string, args: Record<string, unknown>) =>
        runtime.execute({
          threadId: "bw",
          name: name as never,
          arguments: args,
          timeoutMs: 30_000,
        });
      const opened = (await execute("browser_open", { url: origin })) as { tabId: string };
      // A second tab in front must not receive the script meant for the first.
      await runtime.thread("bw")!.context.newPage();
      const result = (await execute("browser_run", {
        tabId: opened.tabId,
        code: 'await human.click(page.getByRole("button", { name: "Go" })); return await page.title();',
      })) as { tabId: string; value: unknown };
      expect(result).toMatchObject({ tabId: opened.tabId, value: "clicked" });
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!hasChromium)(
  "ServerBrowserRuntime keeps pages off the server's own network",
  () => {
    let server: Server;
    let origin: string;
    /** The same fixture by a loopback name: what a page must not reach. */
    let refusedOrigin: string;
    let home: string;
    let runtime: ServerBrowserRuntime;
    let secretHits: number;
    let blocked: string[];

    beforeAll(async () => {
      secretHits = 0;
      blocked = [];
      server = createServer((request, response) => {
        if (request.url === "/secret") {
          secretHits += 1;
          response.writeHead(200, { "content-type": "text/html" }).end("<title>secret</title>");
          return;
        }
        if (request.url === "/to-refused") {
          response.writeHead(302, { location: `${refusedOrigin}/secret` }).end();
          return;
        }
        response
          .writeHead(200, { "content-type": "text/html" })
          .end(
            `<!doctype html><title>Start</title><a id="away" href="${refusedOrigin}/secret">away</a>`,
          );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
      refusedOrigin = `http://localhost:${port}`;
      home = await mkdtemp(join(tmpdir(), "moss-server-browser-guard-"));
      runtime = new ServerBrowserRuntime({
        betterwrightHome: home,
        resolveExecutable: async () => chromiumPath,
        // Only the fixture's own address is let through; everything else meets the real guard.
        navigationGuard: async (url) => url.origin === origin || isServerBrowserNavigable(url),
      });
      runtime.setEvents({
        tabsChanged: () => {},
        controlChanged: () => {},
        dialog: () => {},
        threadClosed: () => {},
        reveal: () => {},
        pendingChanged: () => {},
        download: () => {},
        navigationBlocked: (_threadId, _tabId, host) => blocked.push(host),
      });
    });

    afterAll(async () => {
      await runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    });

    const call = (name: string, args: Record<string, unknown> = {}, threadId = "guard") =>
      runtime.execute({ threadId, name: name as never, arguments: args, timeoutMs: 15_000 });

    it("refuses the agent's own navigation to local and private addresses", async () => {
      for (const url of [
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://[::1]/",
        `${refusedOrigin}/secret`,
      ]) {
        expect(await codeOf(call("browser_open", { url }, "guard-open")), url).toBe(
          "BrowserNavigationBlocked",
        );
      }
      // Refused before a browser was even started for the thread.
      expect(runtime.thread("guard-open")).toBeUndefined();
      expect(secretHits).toBe(0);
    });

    it("refuses a redirect and a page's own navigation to a refused address", async () => {
      const opened = (await call("browser_open", { url: origin })) as { tabId: string };
      expect(await codeOf(call("browser_navigate", { url: `${origin}/to-refused` }))).toBe(
        "BrowserNavigationBlocked",
      );
      expect(blocked).toContain("localhost");

      const tab = runtime.thread("guard")!.tabs.get(opened.tabId)!;
      // The refused redirect leaves the tab on the page it was on.
      expect(tab.page.url()).toBe(`${origin}/`);
      blocked.length = 0;
      await tab.page.click("#away");
      await waitFor(() => blocked.length > 0);
      expect(blocked).toEqual(["localhost"]);
      expect(tab.page.url().startsWith(origin)).toBe(true);
      expect(secretHits).toBe(0);
    });

    it("does not leave a page a script opened on a refused address", async () => {
      const opened = (await call("browser_open", { url: origin })) as { tabId: string };
      const tab = runtime.thread("guard")!.tabs.get(opened.tabId)!;
      blocked.length = 0;
      const before = runtime.thread("guard")!.tabs.size;
      await tab.page.evaluate(`window.open(${JSON.stringify(`${refusedOrigin}/secret`)})`);
      await waitFor(() => blocked.length > 0);
      await waitFor(() => runtime.thread("guard")!.tabs.size === before);
      expect(
        [...runtime.thread("guard")!.tabs.values()].every(
          (candidate) => !candidate.page.url().startsWith(refusedOrigin),
        ),
      ).toBe(true);
      expect(secretHits).toBe(0);
    });
  },
);
