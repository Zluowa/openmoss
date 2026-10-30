import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPrivateDirectoryNoFollowSync,
  ensurePrivateDirectorySync,
  PrivatePathPermissionError,
} from "./privatePathPermissions.ts";

const ownedRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "moss-private-path-"));
  ownedRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of ownedRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("private directory no-follow validation", () => {
  it("inspects a real directory without creating entries or changing its mode", () => {
    const root = makeRoot();
    const directory = path.join(root, "existing");
    fs.mkdirSync(directory, { mode: 0o755 });
    const before = fs.lstatSync(directory);
    const namesBefore = fs.readdirSync(root);
    assertPrivateDirectoryNoFollowSync(directory);
    const after = fs.lstatSync(directory);
    expect(after.isDirectory()).toBe(true);
    expect(after.isSymbolicLink()).toBe(false);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    if (process.platform !== "win32") expect(after.mode).toBe(before.mode);
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(fs.readdirSync(root)).toEqual(namesBefore);
  });

  it("reports a missing directory without creating the directory or its parent", () => {
    const root = makeRoot();
    const directory = path.join(root, "missing-parent", "missing-leaf");
    const namesBefore = fs.readdirSync(root);
    expect(() => assertPrivateDirectoryNoFollowSync(directory)).toThrowError(
      expect.objectContaining({
        name: "PrivatePathPermissionError",
        operation: "inspect without following symlinks",
        path: directory,
        cause: expect.objectContaining({ code: "ENOENT" }),
      }),
    );
    expect(fs.existsSync(path.dirname(directory))).toBe(false);
    expect(fs.readdirSync(root)).toEqual(namesBefore);
  });

  it("rejects a regular file in a private-directory slot without modifying its bytes", () => {
    const root = makeRoot();
    const file = path.join(root, "not-a-directory");
    const contents = Buffer.from("owned no-follow sentinel");
    fs.writeFileSync(file, contents);
    expect(() => assertPrivateDirectoryNoFollowSync(file)).toThrowError(
      expect.objectContaining({
        name: "PrivatePathPermissionError",
        operation: "inspect without following symlinks",
        path: file,
      }),
    );
    expect(fs.readFileSync(file)).toEqual(contents);
  });

  it("rejects a real directory alias before reading or repairing its target", () => {
    const root = makeRoot();
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    fs.mkdirSync(actual, { mode: 0o755 });
    fs.writeFileSync(path.join(actual, "sentinel.txt"), "owned target");
    fs.symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const before = fs.lstatSync(actual);
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(alias, "sentinel.txt"), "utf8")).toBe("owned target");
    expect(() => assertPrivateDirectoryNoFollowSync(alias)).toThrowError(
      expect.objectContaining({
        name: "PrivatePathPermissionError",
        operation: "inspect without following symlinks",
        path: alias,
      }),
    );
    expect(() => ensurePrivateDirectorySync(alias)).toThrow(PrivatePathPermissionError);
    const after = fs.lstatSync(actual);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    if (process.platform !== "win32") expect(after.mode).toBe(before.mode);
    expect(fs.readFileSync(path.join(actual, "sentinel.txt"), "utf8")).toBe("owned target");
    expect(fs.readdirSync(actual)).toEqual(["sentinel.txt"]);
  });

  it("creates real private directories and retains POSIX descriptor permission repair", () => {
    const root = makeRoot();
    const directory = path.join(root, "new-parent", "new-leaf");
    ensurePrivateDirectorySync(directory);
    expect(fs.lstatSync(directory).isDirectory()).toBe(true);
    expect(fs.lstatSync(directory).isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      fs.chmodSync(directory, 0o755);
      ensurePrivateDirectorySync(directory);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
  });
});
