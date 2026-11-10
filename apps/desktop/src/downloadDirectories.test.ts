import * as Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ensureDownloadDirectories, type DownloadDirectoryApp } from "./downloadDirectories";

describe("ensureDownloadDirectories", () => {
  it("creates and publishes both standard picker locations", () => {
    // Absolute on every platform: a drive path such as C:/profile is relative on Linux and macOS,
    // where it would take the home-folder fallback instead.
    const paths = {
      desktop: Path.resolve("/profile", "Desktop"),
      downloads: Path.resolve("/profile", "Downloads"),
    } as const;
    const setPath = vi.fn();
    const app: DownloadDirectoryApp = {
      getPath: (name) => paths[name],
      setPath,
    };
    const mkdirSync = vi.fn();

    expect(ensureDownloadDirectories(app, { mkdirSync })).toEqual(paths);
    expect(mkdirSync).toHaveBeenCalledTimes(2);
    expect(setPath).toHaveBeenNthCalledWith(1, "desktop", paths.desktop);
    expect(setPath).toHaveBeenNthCalledWith(2, "downloads", paths.downloads);
  });

  it("falls back to the profile when a standard path is unavailable", () => {
    const setPath = vi.fn();
    const app: DownloadDirectoryApp = {
      getPath: () => {
        throw new Error("path unavailable");
      },
      setPath,
    };
    const created: string[] = [];

    const result = ensureDownloadDirectories(app, {
      mkdirSync: (directory) => created.push(directory),
    });

    expect(result.desktop).toMatch(/[\\/]Desktop$/u);
    expect(result.downloads).toMatch(/[\\/]Downloads$/u);
    expect(created).toEqual([result.desktop, result.downloads]);
  });
});
