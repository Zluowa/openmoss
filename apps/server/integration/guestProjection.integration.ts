// Production guest build and Chromium. The local HTTP fixture speaks the published protocol
// and validates the submitted delta using the real server decoder. Owner SQLite and relay
// authorization are exercised separately; this fixture does not stand in for them.
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { build } from "vite";
import { safeSeed } from "../src/pages/guestEditing/guestProjectionContent";
import { prepareGuestFrame } from "../src/pages/realtime/guestRoomFrame";
const web = fileURLToPath(new URL("../../web/", import.meta.url)),
  share = "A".repeat(22),
  link = "L".repeat(22),
  pageId = "public-page",
  key = "local-projection-fixture";
// Keep DOM callbacks in the web project while the HTTP fixture and real decoder run under Node.
const browserFixtureUrl = new URL(
  "../../web/src/guest/pages/guestAppPreviewBrowserFixture.ts",
  import.meta.url,
);
const {
  guestAppPreviewBrowser: browserChecks,
}: {
  guestAppPreviewBrowser: import("../../web/src/guest/pages/guestAppPreviewBrowserContract").GuestAppPreviewBrowser;
} = await import(browserFixtureUrl.href);
const artifactDir =
  process.env.MOSS_GUEST_EDIT_ARTIFACT_DIR ??
  path.join(web, "node_modules/.cache/guest-edit-browser");
const ticket = { sessionKey: "f".repeat(64), epoch: "a".repeat(32) };
let scratch = "",
  origin = "",
  server: Server,
  browser: Browser,
  ctx: BrowserContext,
  page: Page,
  stream: ServerResponse | undefined;
let allowed = true,
  advertised = true,
  lostAck = false,
  revision = 1,
  snapshot: Uint8Array,
  rich = "",
  current = "Original text",
  payloads: string[] = [],
  closes = 0;
function event(type: "ready" | "refresh" | "ended") {
  stream?.write(
    "data: " + JSON.stringify({ v: 1, type, ...(type === "ready" ? { revision } : {}) }) + "\n\n",
  );
  if (type !== "ready") stream?.end();
}
beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "moss-guest-projection-"));
  const buildStarted = Date.now();
  await build({
    configFile: path.join(web, "vite.guest.config.ts"),
    root: web,
    logLevel: "warn",
    build: { outDir: scratch, emptyOutDir: false },
  });
  console.info(
    "Guest projection browser: production build finished",
    Date.now() - buildStarted,
    "ms",
  );
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, "http://fixture");
      const send = (code: number, data: unknown) => {
        res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(data));
      };
      if (req.method === "GET") {
        const f = url.pathname.startsWith("/p/") ? "index.html" : url.pathname.slice(1);
        const dest = path.resolve(scratch, f);
        if (!dest.startsWith(scratch + path.sep)) {
          send(404, {});
          return;
        }
        try {
          const bytes = await readFile(dest);
          res.writeHead(200, {
            "content-type": f.endsWith(".js")
              ? "application/javascript"
              : f.endsWith(".css")
                ? "text/css"
                : f.endsWith(".html")
                  ? "text/html"
                  : "application/octet-stream",
          });
          res.end(bytes);
        } catch {
          send(404, {});
        }
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()),
        route = url.pathname.split("/").at(-1);
      if (url.search || !url.pathname.startsWith("/v1/shares/" + share + "/guest/")) {
        send(404, {});
        return;
      }
      if (route === "page") {
        send(200, {
          mode: "share",
          title: "Space",
          role: allowed ? "edit" : "view",
          viewerName: null,
          canComment: false,
          ...(advertised && allowed ? { editProjection: { v: 1 } } : {}),
          pages: [{ id: pageId, title: "Shared note", parentId: null }],
          page: {
            id: pageId,
            title: "Shared note",
            kind: "page",
            revision,
            richContent: rich,
            content: current,
            updatedAt: new Date().toISOString(),
          },
        });
        return;
      }
      if (!allowed || body.entry?.key !== key || body.pageId !== pageId || body.v !== 1) {
        send(404, { reason: "unavailable" });
        return;
      }
      if (route === "page-edit-open") {
        snapshot = safeSeed(rich).seed;
        send(200, {
          v: 1,
          revision,
          ticket,
          seed: Buffer.from(snapshot).toString("base64url"),
          expiresInMs: 60000,
        });
        return;
      }
      if (body.ticket?.sessionKey !== ticket.sessionKey || body.ticket?.epoch !== ticket.epoch) {
        send(404, { reason: "unavailable" });
        return;
      }
      if (route === "page-edit-events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        stream = res;
        event("ready");
        res.on("close", () => {
          if (stream === res) stream = undefined;
        });
        return;
      }
      if (route === "page-edit-close") {
        closes++;
        stream?.end();
        res.writeHead(204);
        res.end();
        return;
      }
      if (route === "page-edit-update") {
        payloads.push(body.update);
        if (payloads.length === 1) {
          const applied = prepareGuestFrame(snapshot, Buffer.from(body.update, "base64url"));
          rich = applied.rich.richContent;
          current = applied.rich.content;
          revision++;
        } else if (payloads[0] !== body.update) {
          send(409, { reason: "conflict" });
          return;
        }
        if (lostAck) {
          lostAck = false;
          res.destroy();
          return;
        }
        send(200, { v: 1, revision, applied: true });
        return;
      }
      send(404, { reason: "unavailable" });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  browser = await chromium.launch({ headless: true });
}, 120000);
afterAll(async () => {
  await browser?.close();
  stream?.end();
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (
    scratch &&
    path.dirname(scratch) === os.tmpdir() &&
    path.basename(scratch).startsWith("moss-guest-projection-")
  )
    await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  allowed = advertised = true;
  lostAck = false;
  revision = 1;
  current = "Original text";
  rich = JSON.stringify([
    { type: "p", children: [{ text: "Original", bold: true }, { text: " text" }] },
  ]);
  payloads = [];
  closes = 0;
  stream = undefined;
  ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1100, height: 790 } });
  page = await ctx.newPage();
  page.setDefaultTimeout(5500);
});
afterEach(async () => {
  await ctx?.close();
  stream?.end();
});
const visit = async () => {
  await page.goto(origin + "/p/" + share + "?l=" + link + "#" + key);
  await page.getByRole("heading", { name: "Shared note" }).waitFor();
};
const edit = async () => {
  await visit();
  await page.getByRole("button", { name: "Edit page", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Page text" });
  await page.getByRole("status").filter({ hasText: "Edit the paragraphs" }).waitFor();
  await field.click();
  await field.press("End");
  await page.keyboard.insertText(" with a guest edit");
  await expect
    .poll(() => page.getByRole("button", { name: "Save changes" }).isEnabled())
    .toBe(true);
  return field;
};
describe("published-only guest editing in Chromium", () => {
  it("uses a Slate/Yjs delta, preserves formatting and refreshes the saved page", async () => {
    await edit();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("status").filter({ hasText: "Page changes saved" }).waitFor();
    expect(revision).toBe(2);
    expect(current).toContain("with a guest edit");
    expect(JSON.parse(rich)[0].children[0]).toEqual({ text: "Original", bold: true });
    expect(payloads).toHaveLength(1);
    await expect.poll(() => closes).toBe(1);
  });
  it.each(["refresh", "ended"] as const)(
    "keeps the local draft after a %s event and never submits it automatically",
    async (type) => {
      const field = await edit();
      event(type);
      await page
        .getByRole("status")
        .filter({ hasText: type === "refresh" ? "The page changed" : "Editing access" })
        .waitFor();
      expect(await field.textContent()).toContain("with a guest edit");
      expect(await field.getAttribute("contenteditable")).toBe("false");
      expect(payloads).toEqual([]);
      await page.getByRole("button", { name: "Close editor", exact: true }).click();
      await page.getByRole("button", { name: "Keep draft" }).click();
      expect(await field.textContent()).toContain("guest edit");
      await mkdir(artifactDir, { recursive: true });
      await page.screenshot({ path: path.join(artifactDir, "draft-" + type + ".png") });
    },
  );
  it("recovers a lost save receipt with the same bytes only after an explicit click", async () => {
    await edit();
    lostAck = true;
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("status").filter({ hasText: "save could not be confirmed" }).waitFor();
    expect(revision).toBe(2);
    expect(payloads).toHaveLength(1);
    await page.getByRole("button", { name: "Check save receipt" }).click();
    await page.getByRole("status").filter({ hasText: "Page changes saved" }).waitFor();
    expect(revision).toBe(2);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
  });
  it("keeps the Chinese draft visible and read only after access ends on a narrow viewport", async () => {
    await ctx.close();
    ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 390, height: 844 } });
    page = await ctx.newPage();
    page.setDefaultTimeout(5500);
    await visit();
    await page.getByRole("button", { name: "编辑正文", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "完成后点击保存" }).waitFor();
    const field = page.getByRole("textbox", { name: "页面正文" });
    await field.click();
    await field.press("End");
    await page.keyboard.insertText("，访客的草稿");
    await expect.poll(() => page.getByRole("button", { name: "保存修改" }).isEnabled()).toBe(true);
    event("ended");
    await page.getByRole("status").filter({ hasText: "已输入的草稿仍保留在这里" }).waitFor();
    expect(await field.textContent()).toContain("访客的草稿");
    expect(await field.getAttribute("aria-readonly")).toBe("true");
    expect(await page.getByText("可以编辑", { exact: true }).count()).toBe(0);
    expect(payloads).toEqual([]);
    expect(await page.evaluate(browserChecks.fitsViewport)).toBe(true);
    await mkdir(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, "draft-ended-zh.png") });
    allowed = false;
    await page.getByRole("button", { name: "关闭编辑" }).click();
    await page.getByRole("button", { name: /放弃/ }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "编辑正文", exact: true }).count())
      .toBe(0);
  });
  it("keeps a legacy owner read only even with an edit role", async () => {
    advertised = false;
    await visit();
    expect(await page.getByRole("button", { name: "Edit page", exact: true }).count()).toBe(0);
    expect(payloads).toEqual([]);
  });
});
