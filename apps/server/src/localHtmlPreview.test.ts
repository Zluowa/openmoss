import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalPreviewGrant, LOCAL_PREVIEW_GRANT_MAX_LIFETIME_MS } from "./localImageFiles";
import {
  localHtmlPreviewContentSecurityPolicy,
  resolveLocalHtmlPreviewAsset,
} from "./localHtmlPreview";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-html-grant-"));
  roots.push(root);
  const source = path.join(root, "index.html");
  await fs.writeFile(source, "<h1>preview</h1>");
  const { grant } = await createLocalPreviewGrant({ requestedPath: source });
  return { root, source, prefix: `/api/local-html/${grant}/` };
}
/** The document lives in `<parent>/site`; `<parent>/private.png` is outside its tree. */
async function nestedFixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "moss-html-tree-"));
  roots.push(parent);
  const site = path.join(parent, "site");
  await fs.mkdir(path.join(site, "assets", "img"), { recursive: true });
  await fs.writeFile(path.join(site, "index.html"), '<img src="assets/img/logo.png">');
  await fs.writeFile(path.join(site, "assets", "img", "logo.png"), "logo");
  await fs.writeFile(path.join(parent, "private.png"), "private");
  const { grant } = await createLocalPreviewGrant({ requestedPath: path.join(site, "index.html") });
  return { parent, site, prefix: `/api/local-html/${grant}/` };
}

it("keeps an open preview's grant alive by use and by re-granting the file, up to a cap", async () => {
  const { site, prefix } = await nestedFixture();
  const startMs = Date.now();
  const at = (offsetMs: number) => vi.spyOn(Date, "now").mockReturnValue(startMs + offsetMs);
  const page = `${prefix}index.html`;

  // A page or asset loaded at 100 s renews the grant past its first 120 s.
  at(100_000);
  expect(await resolveLocalHtmlPreviewAsset(`${prefix}assets/img/logo.png`)).not.toBeNull();
  at(200_000);
  expect(await resolveLocalHtmlPreviewAsset(page)).not.toBeNull();

  // An idle frame stays valid while the client keeps re-granting the open file.
  for (let offsetMs = 300_000; offsetMs <= 1_200_000; offsetMs += 100_000) {
    at(offsetMs);
    await createLocalPreviewGrant({ requestedPath: path.join(site, "index.html") });
  }
  at(1_300_000);
  expect(await resolveLocalHtmlPreviewAsset(page)).not.toBeNull();

  // Once the client stops (the frame is closed), the grant runs out.
  at(1_300_000 + 121_000);
  expect(await resolveLocalHtmlPreviewAsset(page)).toBeNull();
});

it("never renews a grant past its lifetime cap", async () => {
  const { site, prefix } = await nestedFixture();
  const startMs = Date.now();
  const at = (offsetMs: number) => vi.spyOn(Date, "now").mockReturnValue(startMs + offsetMs);
  const page = `${prefix}index.html`;
  for (
    let offsetMs = 60_000;
    offsetMs < LOCAL_PREVIEW_GRANT_MAX_LIFETIME_MS + 60_000;
    offsetMs += 60_000
  ) {
    at(offsetMs);
    await createLocalPreviewGrant({ requestedPath: path.join(site, "index.html") });
    await resolveLocalHtmlPreviewAsset(page);
  }
  at(LOCAL_PREVIEW_GRANT_MAX_LIFETIME_MS + 1);
  expect(await resolveLocalHtmlPreviewAsset(page)).toBeNull();
});

it("serves assets anywhere inside the document's own folder tree", async () => {
  const { site, prefix } = await nestedFixture();
  const asset = await resolveLocalHtmlPreviewAsset(`${prefix}assets/img/logo.png`);
  expect(asset?.path).toBe(await fs.realpath(path.join(site, "assets", "img", "logo.png")));
});

it("never leaves the folder tree through parent, absolute, drive or UNC references", async () => {
  const { parent, prefix } = await nestedFixture();
  const outsideFile = path.join(parent, "private.png");
  for (const target of [
    "../private.png",
    "..%2fprivate.png",
    "%2e%2e%2fprivate.png",
    "assets/..%2f..%2f..%2fprivate.png",
    "assets/%2e%2e/%2e%2e/private.png",
    "..%5cprivate.png",
    // Absolute paths, POSIX and Windows, raw and encoded.
    encodeURIComponent(outsideFile),
    encodeURIComponent(outsideFile.replaceAll("\\", "/")),
    "%2Fetc%2Fhosts.png",
    "/etc/hosts.png",
    // Drive-letter forms.
    "C:/Windows/private.png",
    "C%3A%5CWindows%5Cprivate.png",
    "C%3Aprivate.png",
    // UNC and device forms.
    "/server/share/private.png",
    "%2F%2Fserver%2Fshare%2Fprivate.png",
    "%5C%5Cserver%5Cshare%5Cprivate.png",
    "%5C%5C%3F%5CC%3A%5Cprivate.png",
    // Alternate data streams.
    "index.html%3A%24DATA",
  ]) {
    expect(await resolveLocalHtmlPreviewAsset(`${prefix}${target}`), target).toBeNull();
  }
});

it("rejects a file symlink that points outside the grant root", async () => {
  const { site, parent, prefix } = await nestedFixture();
  try {
    await fs.symlink(path.join(parent, "private.png"), path.join(site, "linked.png"), "file");
  } catch (error) {
    // Windows needs Developer Mode or elevation for file symlinks; junctions are
    // covered separately below.
    if ((error as NodeJS.ErrnoException).code === "EPERM") return;
    throw error;
  }
  expect(await resolveLocalHtmlPreviewAsset(`${prefix}linked.png`)).toBeNull();
});

it("allows only inline, data and same-folder resources and no network", () => {
  const scope = "http://127.0.0.1:5733/api/local-html/grant/";
  const csp = localHtmlPreviewContentSecurityPolicy(scope);
  expect(csp.split("; ")).toEqual(
    expect.arrayContaining([
      "sandbox allow-scripts",
      "default-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "form-action 'none'",
    ]),
  );
  expect(csp).not.toMatch(/allow-same-origin|allow-forms|allow-popups|allow-top-navigation/u);
  expect(csp).not.toMatch(/https?:(?!\/\/127\.0\.0\.1:5733\/api\/local-html\/grant\/)/u);
});
it("expires capabilities and rejects a non-HTML grant", async () => {
  const { root, source, prefix } = await fixture();
  expect((await resolveLocalHtmlPreviewAsset(`${prefix}index.html`))?.path).toBe(source);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
  expect(await resolveLocalHtmlPreviewAsset(`${prefix}index.html`)).toBeNull();
  await fs.writeFile(path.join(root, "data.json"), "{}");
  const { grant } = await createLocalPreviewGrant({ requestedPath: path.join(root, "data.json") });
  expect(await resolveLocalHtmlPreviewAsset(`/api/local-html/${grant}/index.html`)).toBeNull();
});
it("rejects directory junctions escaping the grant root", async () => {
  const { root, prefix } = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "moss-html-outside-"));
  roots.push(outside);
  await fs.writeFile(path.join(outside, "outside.png"), "private");
  await fs.symlink(
    outside,
    path.join(root, "assets"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(await resolveLocalHtmlPreviewAsset(`${prefix}assets/outside.png`)).toBeNull();
});
it("rejects oversized HTML, directory requests and encoded traversal", async () => {
  const { root, prefix } = await fixture();
  await fs.writeFile(path.join(root, "large.html"), "x".repeat(5_000_001));
  for (const target of [
    "large.html",
    "",
    "../index.html",
    "%2e%2e/index.html",
    "%2e/index.html",
    "%00.html",
    "%ZZ.html",
  ]) {
    expect(await resolveLocalHtmlPreviewAsset(`${prefix}${target}`)).toBeNull();
  }
});
