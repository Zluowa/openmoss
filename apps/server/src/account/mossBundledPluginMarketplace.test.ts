import {
  fsyncSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { supportsPosixPermissions } from "@synara/shared/filesystemPlatform";

import {
  MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
  MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME,
  MOSS_BUNDLED_WEB_BUILDER_PLUGIN_NAME,
  materializeMossBundledPluginMarketplace,
  mossBundledPluginMarketplaceRoot,
} from "./mossBundledPluginMarketplace";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const roots: string[] = [];

function makeManagedHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), "moss-bundled-marketplace-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.mocked(fsyncSync).mockReset().mockImplementation(actualFs.fsyncSync);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Moss bundled plugin marketplace", () => {
  it("materializes a native Codex marketplace with an installable production plugin", () => {
    const managedHome = makeManagedHome();
    const result = materializeMossBundledPluginMarketplace(managedHome);
    const marketplace = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
      name: string;
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
        policy: { installation: string; authentication: string };
      }>;
    };

    expect(result.root).toBe(mossBundledPluginMarketplaceRoot(managedHome));
    expect(marketplace).toMatchObject({
      name: MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME,
      plugins: expect.arrayContaining([
        expect.objectContaining({
          name: MOSS_BUNDLED_WEB_BUILDER_PLUGIN_NAME,
          source: { source: "local", path: "./plugins/moss-web-builder" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        }),
      ]),
    });
    const pluginRoot = path.join(result.root, "plugins", MOSS_BUNDLED_WEB_BUILDER_PLUGIN_NAME);
    expect(
      JSON.parse(readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")),
    ).toMatchObject({
      name: MOSS_BUNDLED_WEB_BUILDER_PLUGIN_NAME,
      version: "1.0.0",
      author: { name: "Moss" },
    });
    expect(
      readFileSync(path.join(pluginRoot, "skills", "web-app-builder", "SKILL.md"), "utf8"),
    ).toContain("Moss Web App Builder");
    expect(lstatSync(result.root).isDirectory()).toBe(true);
  });

  it("ships executable media skills without supplier credentials and advertises the default", () => {
    const home = makeManagedHome();
    const result = materializeMossBundledPluginMarketplace(home);
    const marketplace = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(marketplace.plugins).toHaveLength(14);
    expect(
      marketplace.plugins.find((plugin: { name: string }) => plugin.name === "moss-imagegen").policy
        .installation,
    ).toBe("INSTALLED_BY_DEFAULT");
    const mediaRoot = path.join(result.root, "plugins", "moss-imagegen");
    expect(
      readFileSync(path.join(mediaRoot, "skills", "moss-imagegen", "SKILL.md"), "utf8"),
    ).toContain("Never resubmit after a timeout");
    const videoSkill = readFileSync(
      path.join(result.root, "plugins", "moss-kling", "skills", "moss-kling", "SKILL.md"),
      "utf8",
    );
    expect(videoSkill).toContain("description: Generate videos from text");
    expect(videoSkill).not.toContain("Generate or edit videos");
    expect(videoSkill).toContain("Check the catalog's reference capabilities first.");
    expect(videoSkill).toContain(
      "never drop supplied media or silently turn an edit into text-to-video",
    );
    expect(videoSkill).toContain(
      "Missing configured input prices block admission before supplier submission.",
    );
    if (supportsPosixPermissions()) {
      expect(
        lstatSync(path.join(mediaRoot, "skills", "moss-imagegen", "SKILL.md")).mode & 0o077,
      ).toBe(0);
    }
    expect(
      marketplace.plugins.find((plugin: { name: string }) => plugin.name === "moss-plugin-creator")
        .policy.installation,
    ).toBe("INSTALLED_BY_DEFAULT");
    expect(
      readFileSync(
        path.join(
          result.root,
          "plugins",
          "moss-plugin-creator",
          "skills",
          "plugin-creator",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("name: plugin-creator");
  });

  it("leads with image generation and Canvas, and ships Canvas for every CLI format", () => {
    const result = materializeMossBundledPluginMarketplace(makeManagedHome());
    const marketplace = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(marketplace.plugins.slice(0, 2).map((plugin: { name: string }) => plugin.name)).toEqual([
      "moss-imagegen",
      MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
    ]);
    expect(
      marketplace.plugins.find(
        (plugin: { name: string }) => plugin.name === MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
      ),
    ).toMatchObject({
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Creativity",
    });
    const canvasRoot = path.join(result.root, "plugins", MOSS_BUNDLED_CANVAS_PLUGIN_NAME);
    for (const format of [".codex-plugin", ".claude-plugin"]) {
      expect(
        JSON.parse(readFileSync(path.join(canvasRoot, format, "plugin.json"), "utf8")),
      ).toMatchObject({
        name: MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
        interface: { displayName: "Moss Canvas", developerName: "Moss" },
      });
    }
    const skill = readFileSync(
      path.join(canvasRoot, "skills", MOSS_BUNDLED_CANVAS_PLUGIN_NAME, "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("name: moss-canvas");
    expect(skill).toContain("`moss_canvas_open` only when the user explicitly asks");
  });

  it("is byte-idempotent and refuses a symlinked Moss-owned root", () => {
    const managedHome = makeManagedHome();
    const first = materializeMossBundledPluginMarketplace(managedHome);
    const firstManifest = readFileSync(first.manifestPath, "utf8");
    const second = materializeMossBundledPluginMarketplace(managedHome);
    expect(readFileSync(second.manifestPath, "utf8")).toBe(firstManifest);

    const attackedHome = makeManagedHome();
    symlinkSync(
      first.root,
      mossBundledPluginMarketplaceRoot(attackedHome),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => materializeMossBundledPluginMarketplace(attackedHome)).toThrow(/symbolic link/i);
  });

  it("keeps the previous file intact and removes the temporary file when a regular-file flush fails", () => {
    const home = makeManagedHome();
    const result = materializeMossBundledPluginMarketplace(home);
    const previous = '{"previous":"marketplace"}\n';
    writeFileSync(result.manifestPath, previous);
    const error = Object.assign(new Error("disk flush failed"), { code: "EIO" });
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw error;
    });

    expect(() => materializeMossBundledPluginMarketplace(home)).toThrow(error);
    expect(readFileSync(result.manifestPath, "utf8")).toBe(previous);
    expect(readdirSync(path.dirname(result.manifestPath))).toEqual(["marketplace.json"]);
  });
});
