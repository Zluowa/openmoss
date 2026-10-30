import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectoryAlias } from "../../../scripts/fixtures/filesystem-links.ts";

import {
  INLINE_VISUALIZATION_MAX_BYTES,
  INLINE_VISUALIZATION_DOCUMENT_SECURITY_HEADERS,
  hasUnknownVisualizationDependency,
  inlineVisualizationLibraryContentType,
  inlineVisualizationDocument,
  rewriteInlineVisualizationCdnUrls,
  validateInlineVisualizationFile,
  validateWorkspaceInlineVisualizationFile,
} from "./inlineVisualization";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) =>
        import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })),
      ),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "moss-inline-visualization-"));
  roots.push(root);
  const codexHome = path.join(root, "codex");
  const directory = path.join(codexHome, "visualizations", "2026", "10", "08", "native-thread");
  await mkdir(directory, { recursive: true });
  const page = path.join(directory, "chart.html");
  await writeFile(page, "<div id=chart></div>");
  return { root, codexHome, directory, page };
}

describe("Codex inline visualization files", () => {
  it("accepts only the current native thread's single-level html", async () => {
    const { codexHome, page } = await fixture();
    // The validator realpaths the file (symlink-escape defense); on macOS the
    // tmpdir itself is a /var -> /private/var symlink, so compare canonical.
    await expect(
      validateInlineVisualizationFile({
        requestedPath: page,
        codexHome,
        codexThreadId: "native-thread",
      }),
    ).resolves.toMatchObject({ path: await realpath(page) });
  });

  it("rejects traversal, other threads, nested paths, non-html and oversize files", async () => {
    const { root, codexHome, directory, page } = await fixture();
    const nested = path.join(directory, "nested");
    const otherThread = path.join(
      codexHome,
      "visualizations",
      "2026",
      "10",
      "08",
      "other-thread",
      "chart.html",
    );
    const text = path.join(directory, "chart.txt");
    const huge = path.join(directory, "huge.html");
    await mkdir(nested, { recursive: true });
    await mkdir(path.dirname(otherThread), { recursive: true });
    await Promise.all([
      writeFile(path.join(nested, "chart.html"), "nested"),
      writeFile(otherThread, "other"),
      writeFile(text, "text"),
      writeFile(huge, Buffer.alloc(INLINE_VISUALIZATION_MAX_BYTES + 1)),
    ]);
    const check = (requestedPath: string) =>
      validateInlineVisualizationFile({ requestedPath, codexHome, codexThreadId: "native-thread" });
    await expect(check(`${directory}/../native-thread/chart.html`)).resolves.toBe("invalid-path");
    await expect(check(otherThread)).resolves.toBe("outside-thread");
    await expect(check(path.join(nested, "chart.html"))).resolves.toBe("outside-thread");
    await expect(check(text)).resolves.toBe("invalid-path");
    await expect(check(huge)).resolves.toBe("too-large");
    await expect(check(path.join(root, "secret.html"))).resolves.toBe("missing");
  });

  it.each(["../native-thread/chart.html", "..\\native-thread\\chart.html"])(
    "rejects traversal with either accepted path separator: %s",
    async (suffix) => {
      const { codexHome, directory } = await fixture();
      await expect(
        validateInlineVisualizationFile({
          requestedPath: `${directory}${path.sep}${suffix}`,
          codexHome,
          codexThreadId: "native-thread",
        }),
      ).resolves.toBe("invalid-path");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlink escaping the native thread directory",
    async () => {
      const { root, codexHome, directory } = await fixture();
      const secret = path.join(root, "secret.html");
      const link = path.join(directory, "escape.html");
      await writeFile(secret, "secret");
      await symlink(secret, link);
      await expect(
        validateInlineVisualizationFile({
          requestedPath: link,
          codexHome,
          codexThreadId: "native-thread",
        }),
      ).resolves.toBe("outside-thread");
    },
  );

  it("rejects a readable file through a directory alias escaping the native thread", async () => {
    const { root, codexHome, directory } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.html"), "secret");
    createDirectoryAlias(outside, path.join(directory, "linked"));
    const requestedPath = path.join(directory, "linked", "secret.html");
    expect(await readFile(requestedPath, "utf8")).toBe("secret");
    await expect(
      validateInlineVisualizationFile({ requestedPath, codexHome, codexThreadId: "native-thread" }),
    ).resolves.toBe("outside-thread");
  });
});

describe("workspace inline visualization files (Moss multi-provider threads)", () => {
  async function workspaceFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "moss-workspace-visualization-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "worktree");
    const directory = path.join(workspaceRoot, "visualizations");
    await mkdir(directory, { recursive: true });
    const page = path.join(directory, "special-relativity.html");
    await writeFile(page, "<div id=relativity></div>");
    return { root, workspaceRoot, directory, page };
  }

  it("resolves a workspace-relative html path", async () => {
    const { workspaceRoot, page } = await workspaceFixture();
    await expect(
      validateWorkspaceInlineVisualizationFile({
        requestedPath: "visualizations/special-relativity.html",
        workspaceRoot,
      }),
    ).resolves.toMatchObject({ path: await realpath(page) });
  });

  it("resolves an absolute path inside the workspace", async () => {
    const { workspaceRoot, page } = await workspaceFixture();
    await expect(
      validateWorkspaceInlineVisualizationFile({ requestedPath: page, workspaceRoot }),
    ).resolves.toMatchObject({ path: await realpath(page) });
  });

  it("rejects traversal, absolute escapes, non-html and oversize files", async () => {
    const { root, workspaceRoot, directory } = await workspaceFixture();
    const outside = path.join(root, "secret.html");
    const nested = path.join(directory, "nested");
    const text = path.join(directory, "notes.txt");
    const huge = path.join(directory, "huge.html");
    await mkdir(nested, { recursive: true });
    await Promise.all([
      writeFile(outside, "secret"),
      writeFile(path.join(nested, "deep.html"), "deep"),
      writeFile(text, "text"),
      writeFile(huge, Buffer.alloc(INLINE_VISUALIZATION_MAX_BYTES + 1)),
    ]);
    const check = (requestedPath: string) =>
      validateWorkspaceInlineVisualizationFile({ requestedPath, workspaceRoot });
    await expect(check("../secret.html")).resolves.toBe("invalid-path");
    await expect(check("visualizations/../../secret.html")).resolves.toBe("invalid-path");
    await expect(check(outside)).resolves.toBe("outside-workspace");
    await expect(check(text)).resolves.toBe("invalid-path");
    await expect(check("visualizations/notes.txt")).resolves.toBe("invalid-path");
    await expect(check("visualizations/huge.html")).resolves.toBe("too-large");
    await expect(check("visualizations/missing.html")).resolves.toBe("missing");
    // Nested workspace files stay readable; the workspace root is the boundary,
    // not the visualizations/ subdirectory.
    await expect(check("visualizations/nested/deep.html")).resolves.toMatchObject({
      sha256: expect.any(String),
    });
  });

  it.runIf(process.platform !== "win32")("rejects a symlink escaping the workspace", async () => {
    const { root, workspaceRoot, directory } = await workspaceFixture();
    const secret = path.join(root, "secret.html");
    const link = path.join(directory, "escape.html");
    await writeFile(secret, "secret");
    await symlink(secret, link);
    await expect(
      validateWorkspaceInlineVisualizationFile({
        requestedPath: "visualizations/escape.html",
        workspaceRoot,
      }),
    ).resolves.toBe("outside-workspace");
  });

  it("rejects a readable file through a directory alias escaping the workspace", async () => {
    const { root, workspaceRoot, directory } = await workspaceFixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.html"), "secret");
    createDirectoryAlias(outside, path.join(directory, "linked"));
    expect(await readFile(path.join(directory, "linked", "secret.html"), "utf8")).toBe("secret");
    await expect(
      validateWorkspaceInlineVisualizationFile({
        requestedPath: "visualizations/linked/secret.html",
        workspaceRoot,
      }),
    ).resolves.toBe("outside-workspace");
  });

  it("rejects a relative workspace root", async () => {
    await expect(
      validateWorkspaceInlineVisualizationFile({
        requestedPath: "visualizations/special-relativity.html",
        workspaceRoot: "relative/worktree",
      }),
    ).resolves.toBe("invalid-path");
  });
});

describe("inline visualization dependency rewriting", () => {
  it("uses T3's document sandbox policy", () => {
    const csp = INLINE_VISUALIZATION_DOCUMENT_SECURITY_HEADERS["Content-Security-Policy"];
    expect(csp).toBe("sandbox allow-scripts allow-forms allow-popups");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("default-src");
  });

  it("maps common allowed CDNs to checked-in local assets", () => {
    const rewritten = rewriteInlineVisualizationCdnUrls(
      '<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><script type="module">import * as THREE from "https://esm.sh/three@0.182.0"</script><link href="https://fonts.googleapis.com/css2?family=Inter">',
    );
    expect(rewritten).toContain("/inline-visualization-libs/d3.min.js");
    expect(rewritten).toContain("/inline-visualization-libs/three.module.js");
    expect(rewritten).toContain("/inline-visualization-libs/fonts.css");
  });

  it("only exposes the fixed local library allowlist", () => {
    expect(inlineVisualizationLibraryContentType("d3.min.js")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(inlineVisualizationLibraryContentType("../server-secret.js")).toBeUndefined();
    expect(inlineVisualizationLibraryContentType("unknown.js")).toBeUndefined();
  });

  it("permits an unknown remote dependency like T3 visual replies", () => {
    const source = '<script src="https://example.test/chart.js"></script>';
    expect(hasUnknownVisualizationDependency(source)).toBe(true);
    expect(inlineVisualizationDocument(source)).toContain(source);
  });
});
