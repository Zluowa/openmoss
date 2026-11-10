import { describe, expect, it, vi } from "vitest";

import { ensureDownloadDirectories, type DownloadDirectoryApp } from "./downloadDirectories";

describe("ensureDownloadDirectories", () => {
  it("creates and publishes both standard picker locations", () => {
    const paths = { desktop: "C:/profile/Desktop", downloads: "C:/profile/Downloads" } as const;
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
