import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceMediaEditFiles, readWorkspaceMediaReferences } from "./mediaReferenceFiles";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FAAAAAASUVORK5CYII=",
  "base64",
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "moss-media-files-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "reference.png"), PNG);
  await writeFile(path.join(root, "outside.png"), PNG);
  return { root, workspace };
}

describe("workspace media reference files", () => {
  it("reads four references plus one mask through the same workspace boundary", async () => {
    const { workspace } = await fixture();
    const files = await readWorkspaceMediaEditFiles(
      workspace,
      Array(4).fill("reference.png"),
      "reference.png",
    );
    expect(files.references).toHaveLength(4);
    expect(files.maskImage).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    await expect(
      readWorkspaceMediaEditFiles(workspace, ["reference.png"], "../outside.png"),
    ).rejects.toMatchObject({ code: "invalid_reference_path" });
  });
  it("shares the local byte budget between source and mask", async () => {
    const { workspace } = await fixture();
    const bytes = Buffer.alloc(3 * 1024 * 1024);
    PNG.copy(bytes);
    await writeFile(path.join(workspace, "large.png"), bytes);
    await expect(
      readWorkspaceMediaEditFiles(workspace, ["large.png"], "large.png"),
    ).rejects.toThrow("file limit");
  });
  it("encodes an explicitly referenced regular image under the caller workspace", async () => {
    const { workspace } = await fixture();
    expect(await readWorkspaceMediaReferences(workspace, ["reference.png"])).toEqual([
      `data:image/png;base64,${PNG.toString("base64")}`,
    ]);
  });
  it("reads thirty video references with the same path and aggregate byte protections", async () => {
    const { workspace } = await fixture();
    const references = Array(30).fill("reference.png");
    expect(await readWorkspaceMediaReferences(workspace, references, 30)).toHaveLength(30);
    await expect(
      readWorkspaceMediaReferences(workspace, [...references, "reference.png"], 30),
    ).rejects.toMatchObject({ code: "invalid_reference_path" });
    const large = Buffer.alloc(200 * 1024);
    PNG.copy(large);
    await writeFile(path.join(workspace, "large.png"), large);
    await expect(
      readWorkspaceMediaReferences(workspace, Array(30).fill("large.png"), 30),
    ).rejects.toThrow("file limit");
    await expect(
      readWorkspaceMediaReferences(workspace, ["../outside.png"], 30),
    ).rejects.toMatchObject({ code: "invalid_reference_path" });
  });
  it("rejects traversal and absolute paths outside the caller workspace", async () => {
    const { root, workspace } = await fixture();
    await expect(readWorkspaceMediaReferences(workspace, ["../outside.png"])).rejects.toMatchObject(
      { code: "invalid_reference_path" },
    );
    await expect(
      readWorkspaceMediaReferences(workspace, [path.join(root, "outside.png")]),
    ).rejects.toMatchObject({ code: "invalid_reference_path" });
  });
  it("rejects symbolic-link files when the OS permits creating the fixture", async ({ skip }) => {
    const { workspace } = await fixture();
    try {
      await symlink(path.join(workspace, "reference.png"), path.join(workspace, "linked.png"));
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip();
        return;
      }
      throw error;
    }
    await expect(readWorkspaceMediaReferences(workspace, ["linked.png"])).rejects.toThrow(
      "not a regular file",
    );
    await expect(
      readWorkspaceMediaEditFiles(workspace, ["reference.png"], "linked.png"),
    ).rejects.toThrow("not a regular file");
  });
  it("rejects an escaped parent directory through a symbolic link or Windows junction", async () => {
    const { root, workspace } = await fixture();
    await symlink(
      root,
      path.join(workspace, "escaped"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      readWorkspaceMediaReferences(workspace, ["escaped/outside.png"]),
    ).rejects.toMatchObject({ code: "invalid_reference_path" });
    await expect(
      readWorkspaceMediaEditFiles(workspace, ["reference.png"], "escaped/outside.png"),
    ).rejects.toMatchObject({ code: "invalid_reference_path" });
  });
  it("rejects SVG or arbitrary text masquerading as a PNG", async () => {
    const { workspace } = await fixture();
    await writeFile(path.join(workspace, "secret.png"), "TOKEN=private-not-an-image");
    await expect(readWorkspaceMediaReferences(workspace, ["secret.png"])).rejects.toMatchObject({
      code: "invalid_reference_type",
    });
  });
  it("enforces a bounded total before encoding image bytes", async () => {
    const { workspace } = await fixture();
    await writeFile(path.join(workspace, "large.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(readWorkspaceMediaReferences(workspace, ["large.png"])).rejects.toThrow(
      "file limit",
    );
    await expect(
      readWorkspaceMediaReferences(workspace, Array(5).fill("reference.png")),
    ).rejects.toMatchObject({ code: "invalid_reference_path" });
  });
});
