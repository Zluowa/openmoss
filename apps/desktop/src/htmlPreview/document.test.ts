import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HtmlPreviewDocument,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_MAX_BYTES,
  isAllowedHtmlPreviewRequest,
} from "./document";

const directories: string[] = [];
async function fixture() {
  const root = await FS.mkdtemp(Path.join(tmpdir(), "moss-html-document-"));
  directories.push(root);
  const source = Path.join(root, "example space.html");
  await FS.writeFile(source, "disk source");
  await FS.mkdir(Path.join(root, "assets"));
  await FS.writeFile(Path.join(root, "assets", "app.mjs"), "window.testValue = 42");
  await FS.writeFile(Path.join(root, "assets", "app.css"), "body { color: red }");
  await FS.writeFile(Path.join(root, ".env"), "secret");
  const html =
    '<link rel="stylesheet" href="assets/app.css"><script type="module" src="assets/app.mjs"></script><script>window.inlineValue=1</script>';
  const document = await HtmlPreviewDocument.create({ html, filePath: source });
  return { root, source, document, html };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const relative = Path.relative(tmpdir(), directory);
    if (
      relative.startsWith("..") ||
      Path.isAbsolute(relative) ||
      !Path.basename(directory).startsWith("moss-html-document-")
    )
      throw new Error("Unsafe test cleanup path");
    await FS.rm(directory, { recursive: true, force: true });
  }
});

describe("isolated HTML document", () => {
  it("serves the selected HTML bytes with an independent script policy and relative assets", async () => {
    const { document, html } = await fixture();
    const fetchFile = vi.fn(
      async (url: string) => new Response(await FS.readFile(fileURLToPath(url), "utf8")),
    );
    const response = await document.respond(new Request(document.descriptor.src), fetchFile);
    expect(await response.text()).toBe(html);
    expect(response.headers.get("content-security-policy")).toBe(HTML_PREVIEW_CSP);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(fetchFile).not.toHaveBeenCalled();
    const js = await document.respond(
      new Request(new URL("assets/app.mjs", document.descriptor.src)),
      fetchFile,
    );
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect(await js.text()).toBe("window.testValue = 42");
    const css = await document.respond(
      new Request(new URL("assets/app.css", document.descriptor.src)),
      fetchFile,
    );
    expect(css.headers.get("content-type")).toBe("text/css");
    expect(await css.text()).toContain("color: red");
    document.dispose();
  });

  it("denies hidden, escaped, unknown-origin, non-GET and revoked requests", async () => {
    const { document } = await fixture();
    const fetchFile = vi.fn();
    for (const name of [".env", "%2eenv", "assets/%2e%2e%2f.env", "assets/%5c.env", "missing.js"]) {
      expect(
        (await document.respond(new Request(new URL(name, document.descriptor.src)), fetchFile))
          .status,
      ).toBe(404);
    }
    expect(
      (await document.respond(new Request("moss-local-preview://different/index.html"), fetchFile))
        .status,
    ).toBe(404);
    expect(
      (await document.respond(new Request(document.descriptor.src, { method: "POST" }), fetchFile))
        .status,
    ).toBe(405);
    const head = await document.respond(
      new Request(document.descriptor.src, { method: "HEAD" }),
      fetchFile,
    );
    expect(await head.text()).toBe("");
    document.dispose();
    expect((await document.respond(new Request(document.descriptor.src), fetchFile)).status).toBe(
      410,
    );
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it("rejects a junction escaping the real source directory", async () => {
    const { document, root } = await fixture();
    const outside = await FS.mkdtemp(Path.join(tmpdir(), "moss-html-document-"));
    directories.push(outside);
    await FS.writeFile(Path.join(outside, "secret.txt"), "secret");
    await FS.symlink(
      outside,
      Path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const fetchFile = vi.fn();
    expect(
      (
        await document.respond(
          new Request(new URL("linked/secret.txt", document.descriptor.src)),
          fetchFile,
        )
      ).status,
    ).toBe(404);
    expect(fetchFile).not.toHaveBeenCalled();
    document.dispose();
  });

  it("uses distinct authorities even for the same file and supports inline documents", async () => {
    const { document, source } = await fixture();
    const second = await HtmlPreviewDocument.create({ html: "second", filePath: source });
    const inline = await HtmlPreviewDocument.create({ html: "inline" });
    expect(second.descriptor.partition).not.toBe(document.descriptor.partition);
    expect(second.descriptor.src).not.toBe(document.descriptor.src);
    expect(inline.descriptor.partition).not.toMatch(/^persist:/u);
    expect(await (await inline.respond(new Request(inline.descriptor.src), vi.fn())).text()).toBe(
      "inline",
    );
    for (const item of [document, second, inline]) item.dispose();
  });

  it("rejects oversize, relative and non-HTML inputs before issuing a grant", async () => {
    await expect(
      HtmlPreviewDocument.create({ html: "x".repeat(HTML_PREVIEW_MAX_BYTES + 1) }),
    ).rejects.toThrow("5 MiB");
    await expect(
      HtmlPreviewDocument.create({ html: "ok", filePath: "index.html" }),
    ).rejects.toThrow("absolute");
    const { root, document } = await fixture();
    await expect(
      HtmlPreviewDocument.create({ html: "ok", filePath: Path.join(root, ".env") }),
    ).rejects.toThrow("Only local HTML");
    document.dispose();
  });

  it("does not finish a resource response after its grant is revoked", async () => {
    const { document } = await fixture();
    let complete: (response: Response) => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = document.respond(
      new Request(new URL("assets/app.css", document.descriptor.src)),
      () => {
        markStarted();
        return new Promise<Response>((accept) => {
          complete = accept;
        });
      },
    );
    await started;
    document.dispose();
    complete(new Response("revoked"));
    expect((await pending).status).toBe(410);
  });
});

describe("HTML guest network boundary", () => {
  const src = "moss-local-preview://fixture/index.html";
  it.each([
    "moss://app/index.html",
    "file:///C:/secret.txt",
    "http://127.0.0.1:5733",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://10.0.0.1",
    "https://192.168.1.2",
    "moss-local-preview://other/index.html",
  ])("denies %s", (url) => {
    expect(isAllowedHtmlPreviewRequest(url, src)).toBe(false);
  });
  it.each([
    "moss-local-preview://fixture/assets/app.js",
    "https://cdn.example.com/library.js",
    "data:image/png;base64,eA==",
    "blob:moss-local-preview://fixture/id",
  ])("allows %s", (url) => {
    expect(isAllowedHtmlPreviewRequest(url, src)).toBe(true);
  });
});
