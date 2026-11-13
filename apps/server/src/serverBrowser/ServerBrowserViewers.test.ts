/**
 * What a person can do from a viewer once they take control: answer dialogs,
 * pick files, download, copy, close tabs; and what presence viewers receive.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ServerBrowserRuntime } from "./ServerBrowserRuntime.ts";
import { ServerBrowserViewerHub } from "./ServerBrowserViewers.ts";

const headlessShell = (() => {
  const explicit = process.env.MOSS_TEST_CHROMIUM?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  try {
    for (const entry of readdirSync(root).filter((name) =>
      /^chromium_headless_shell-\d+$/u.test(name),
    )) {
      const candidate = join(root, entry, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No browsers directory.
  }
  return "";
})();

const PAGE = `<!doctype html><title>Viewer</title>
<button id="ask" style="position:absolute;left:0;top:0;width:200px;height:40px"
  onclick="document.title = 'answer:' + prompt('Your name?', 'moss')">Ask</button>
<input id="file" type="file" accept=".txt" style="position:absolute;left:0;top:60px;width:200px;height:40px"
  onchange="document.title = 'file:' + this.files[0].name + ':' + this.files[0].size">
<a id="get" href="/report.txt" download="report.txt" style="position:absolute;left:0;top:120px;display:block;width:200px;height:40px">Get</a>
<p id="text" style="position:absolute;left:0;top:180px">copy me please</p>`;

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 8_000) => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe.skipIf(headlessShell === "")("server browser viewers", () => {
  let server: Server;
  let origin: string;
  let home: string;
  let runtime: ServerBrowserRuntime;
  let hub: ServerBrowserViewerHub;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/report.txt") {
        response
          .writeHead(200, {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="report.txt"',
          })
          .end("quarterly numbers");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    home = await mkdtemp(join(tmpdir(), "moss-server-browser-viewers-"));
    runtime = new ServerBrowserRuntime({
      betterwrightHome: join(home, "bw"),
      filesDir: join(home, "files"),
      resolveExecutable: async () => headlessShell,
      // The fixture is on loopback, which the server browser otherwise refuses;
      // it is let through by address and by name, nothing else is.
      navigationGuard: async (url) =>
        url.origin === origin || url.origin === origin.replace("127.0.0.1", "localhost"),
    });
    hub = new ServerBrowserViewerHub(runtime);
  });

  afterAll(async () => {
    await runtime.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  const attach = (threadId: string, presence = false) => {
    const texts: Array<Record<string, unknown>> = [];
    let frames = 0;
    // Acks every frame, as the web client does, so the stream keeps flowing.
    const handle = hub.attach(
      threadId,
      {
        sendBinary: () => {
          frames += 1;
          queueMicrotask(() => handle.receive(JSON.stringify({ type: "ack" })));
        },
        sendText: (text) => texts.push(JSON.parse(text) as Record<string, unknown>),
        backlogBytes: () => 0,
        close: () => {},
      },
      { maxWidth: 800, maxHeight: 600, quality: 50, canOperate: true, presence },
    );
    const send = (message: Record<string, unknown>) => handle.receive(JSON.stringify(message));
    const click = (x: number, y: number) => {
      for (const action of ["down", "up"] as const) {
        send({
          type: "mouse",
          action,
          x,
          y,
          button: "left",
          buttons: action === "down" ? 1 : 0,
          clickCount: 1,
          modifiers: 0,
        });
      }
    };
    return { handle, texts, frames: () => frames, send, click };
  };

  it("hands dialogs, file pickers and downloads to the person in control", async () => {
    const presence = attach("people", true);
    await runtime.execute({
      threadId: "people",
      name: "browser_open",
      arguments: { url: origin },
      timeoutMs: 15_000,
    });
    // The agent asked to show its page: presence viewers hear it, without frames.
    expect(presence.texts.some((message) => message.type === "reveal")).toBe(true);

    const viewer = attach("people");
    const tab = runtime.thread("people")!.tabs.values().next().value!;
    await waitFor(() => viewer.frames() > 0);
    expect(presence.frames()).toBe(0);
    viewer.send({ type: "takeControl" });
    await waitFor(() => tab.control.controller !== null);

    // Dialog: held for the person, answered with their text.
    viewer.click(100, 20);
    await waitFor(() => viewer.texts.some((message) => message.type === "dialogOpen"));
    const dialog = viewer.texts.find((message) => message.type === "dialogOpen")!;
    expect(dialog).toMatchObject({ kind: "prompt", message: "Your name?", defaultPrompt: "moss" });
    viewer.send({ type: "dialogAnswer", id: dialog.id, accept: true, promptText: "Ada" });
    await waitFor(async () => (await tab.page.title()) === "answer:Ada");
    expect(viewer.texts.some((message) => message.type === "dialogClosed")).toBe(true);

    // File picker: the person's file lands in the page's input.
    viewer.click(100, 80);
    await waitFor(() => viewer.texts.some((message) => message.type === "fileChooser"));
    const chooser = viewer.texts.find((message) => message.type === "fileChooser")!;
    expect(chooser).toMatchObject({ multiple: false, accept: ".txt" });
    viewer.send({
      type: "fileChooserAnswer",
      id: chooser.id,
      files: [
        {
          name: "notes.txt",
          mimeType: "text/plain",
          data: Buffer.from("hello!").toString("base64"),
        },
      ],
    });
    await waitFor(async () => (await tab.page.title()) === "file:notes.txt:6");

    // Download: kept for the person and served once by its token.
    viewer.click(100, 140);
    await waitFor(() => viewer.texts.some((message) => message.type === "download"));
    const download = viewer.texts.find((message) => message.type === "download")!;
    expect(download).toMatchObject({ fileName: "report.txt", sizeBytes: 17 });
    const token = new URL(String(download.path), "http://moss").searchParams.get("download")!;
    const kept = runtime.takeDownload(token)!;
    expect(await readFile(kept.path, "utf8")).toBe("quarterly numbers");
    // The token is spent on its first use.
    expect(runtime.takeDownload(token)).toBeUndefined();
    expect(runtime.takeDownload("not-a-token")).toBeUndefined();

    // Copy: select the paragraph, then Ctrl+C sends its text to the viewer's clipboard.
    // Runs in the page; the server's own types have no DOM.
    await tab.page.evaluate(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("text"));
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    })()`);
    viewer.send({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 2 });
    viewer.send({ type: "key", action: "up", key: "c", code: "KeyC", modifiers: 2 });
    await waitFor(() =>
      viewer.texts.some(
        (message) => message.type === "clipboard" && message.text === "copy me please",
      ),
    );

    // Closing the tab from the viewer.
    viewer.send({ type: "closeTab", tabId: tab.tabId });
    await waitFor(() => runtime.thread("people")!.tabs.size === 0);

    await viewer.handle.detach();
    await presence.handle.detach();
  }, 60_000);

  it("keeps streaming after the page moves to another site", async () => {
    const viewer = attach("moves");
    await runtime.execute({
      threadId: "moves",
      name: "browser_open",
      arguments: { url: origin, show: false },
      timeoutMs: 15_000,
    });
    await waitFor(() => viewer.frames() > 0);
    // Another site can mean another renderer, which drops a running screencast.
    await runtime.execute({
      threadId: "moves",
      name: "browser_navigate",
      arguments: { url: origin.replace("127.0.0.1", "localhost") },
      timeoutMs: 15_000,
    });
    const afterNavigation = viewer.frames();
    await waitFor(() => viewer.frames() > afterNavigation);
    await viewer.handle.detach();
  }, 30_000);

  it("tells the person when an address they typed is refused", async () => {
    const viewer = attach("typed");
    // With no tab yet, the address bar opens one.
    viewer.send({ type: "open", url: "169.254.169.254/latest/meta-data/" });
    await waitFor(() => viewer.texts.some((message) => message.type === "navigationBlocked"));
    expect(viewer.texts.find((message) => message.type === "navigationBlocked")).toEqual({
      type: "navigationBlocked",
      host: "169.254.169.254",
    });
    expect(runtime.thread("typed")).toBeUndefined();

    await runtime.execute({
      threadId: "typed",
      name: "browser_open",
      arguments: { url: origin, show: false },
      timeoutMs: 15_000,
    });
    const tab = runtime.thread("typed")!.tabs.values().next().value!;
    await waitFor(() => viewer.frames() > 0);
    viewer.send({ type: "takeControl" });
    await waitFor(() => tab.control.controller !== null);
    viewer.texts.length = 0;
    viewer.send({ type: "navigate", url: "http://10.0.0.1/" });
    await waitFor(() => viewer.texts.some((message) => message.type === "navigationBlocked"));
    expect(viewer.texts.find((message) => message.type === "navigationBlocked")).toEqual({
      type: "navigationBlocked",
      host: "10.0.0.1",
    });
    expect(tab.page.url().startsWith(origin)).toBe(true);
    await viewer.handle.detach();
  }, 30_000);

  it("answers dialogs and pickers itself while the agent drives", async () => {
    const viewer = attach("agent-drives");
    await runtime.execute({
      threadId: "agent-drives",
      name: "browser_open",
      arguments: { url: origin, show: false },
      timeoutMs: 15_000,
    });
    const tab = runtime.thread("agent-drives")!.tabs.values().next().value!;
    expect(viewer.texts.some((message) => message.type === "reveal")).toBe(false);
    await tab.page.click("#ask");
    await waitFor(async () => (await tab.page.title()) === "answer:null");
    expect(viewer.texts.some((message) => message.type === "dialogOpen")).toBe(false);
    await viewer.handle.detach();
  }, 30_000);
});
