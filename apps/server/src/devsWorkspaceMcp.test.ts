import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createDevsWorkspaceTools } from "./devsWorkspaceMcp";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-scoped-workspace-"));
  directories.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(root, "private.txt"), "private sentinel outside workspace");
  await fs.writeFile(path.join(workspace, "source.ts"), "first line\nsource bug\n");
  await fs.mkdir(path.join(workspace, ".git"));
  await fs.writeFile(path.join(workspace, ".git", "config"), "private git state");
  return { root, workspace, invoke: await createDevsWorkspaceTools(workspace) };
}
describe("public repair workspace file tools", () => {
  it("supports bounded source inspection and text edits without a command execution tool", async () => {
    const { invoke } = await fixture();
    expect(await invoke("list_files", {})).toBe("source.ts");
    expect(await invoke("read_file", { path: "source.ts", startLine: 2, lineCount: 1 })).toBe(
      "2: source bug",
    );
    expect(await invoke("search_text", { text: "bug" })).toContain("source.ts:2:");
    await invoke("write_file", { path: "new/source.ts", content: "fixed\n" });
    expect(await invoke("read_file", { path: "new/source.ts" })).toContain("fixed");
    await expect(invoke("exec_command", { cmd: "anything" })).rejects.toThrow(
      "Unknown workspace tool",
    );
  });
  it("denies traversal, absolute paths, metadata and verification configuration", async () => {
    const { invoke, root } = await fixture();
    for (const location of [
      "../private.txt",
      path.join(root, "private.txt"),
      ".git/config",
      ".env",
      ".github/workflows/test.yml",
    ])
      await expect(invoke("read_file", { path: location })).rejects.toThrow();
    for (const location of ["AGENTS.md", "package.json", "vitest.config.ts"])
      await expect(
        invoke("write_file", { path: location, content: "do not write" }),
      ).rejects.toThrow("Protected");
    await expect(invoke("read_file", { path: "source.ts", lineCount: 501 })).rejects.toThrow(
      "line range",
    );
  });
  it("refuses Git and Git LFS configuration, including Windows aliases of it", async () => {
    const { invoke, workspace } = await fixture();
    for (const location of [
      ".gitattributes",
      "nested/.gitattributes",
      ".lfsconfig",
      ".gitmodules",
      ".gitignore",
      "patches/x.patch",
      "bunfig.toml",
    ])
      await expect(
        invoke("write_file", { path: location, content: "* filter=lfs" }),
      ).rejects.toThrow("Protected");
    for (const location of [".lfsconfig.", ".gitattributes ", ".lfsconfig::$DATA", "a:b.ts"])
      await expect(
        invoke("write_file", { path: location, content: "* filter=lfs" }),
      ).rejects.toThrow("Ambiguous");
    expect((await fs.readdir(workspace)).toSorted()).toEqual([".git", "source.ts"]);
  });
  it("does not follow a directory junction out of the checkout or into protected metadata", async () => {
    const { invoke, root, workspace } = await fixture();
    await fs.symlink(
      root,
      path.join(workspace, "external"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.symlink(
      path.join(workspace, ".git"),
      path.join(workspace, "metadata"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(invoke("read_file", { path: "external/private.txt" })).rejects.toThrow("outside");
    await expect(
      invoke("write_file", { path: "external/new.txt", content: "do not write" }),
    ).rejects.toThrow("outside");
    await expect(invoke("read_file", { path: "metadata/config" })).rejects.toThrow("Protected");
  });
  it("replaces hard-linked files without modifying a shared cache inode", async () => {
    const { invoke, root, workspace } = await fixture();
    const cache = path.join(root, "cached.txt");
    await fs.writeFile(cache, "cache original");
    await fs.link(cache, path.join(workspace, "cached-copy.txt"));
    await invoke("write_file", { path: "cached-copy.txt", content: "workspace edit" });
    expect(await fs.readFile(cache, "utf8")).toBe("cache original");
    expect(await fs.readFile(path.join(workspace, "cached-copy.txt"), "utf8")).toBe(
      "workspace edit",
    );
  });
});
