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
import { supportsPosixPermissions } from "@moss/shared/filesystemPlatform";

import {
  MOSS_IMAGE_MODEL_IDS,
  MOSS_MEDIA_PLUGINS,
  MOSS_VIDEO_MODEL_IDS,
} from "@moss/shared/mossMediaPlugins";
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

  it("ships one general image and video skill plus one skill per vendor, with every model's cost", () => {
    const home = makeManagedHome();
    const result = materializeMossBundledPluginMarketplace(home);
    const marketplace = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    const names = marketplace.plugins.map((plugin: { name: string }) => plugin.name);
    expect(names).toEqual([
      ...MOSS_MEDIA_PLUGINS.map((plugin) => plugin.name),
      MOSS_BUNDLED_WEB_BUILDER_PLUGIN_NAME,
      "moss-plugin-creator",
    ]);
    expect(names).not.toContain("moss-nano-banana-2");
    const installation = (name: string) =>
      marketplace.plugins.find((plugin: { name: string }) => plugin.name === name).policy
        .installation;
    for (const name of ["moss-imagegen", "moss-videogen", MOSS_BUNDLED_CANVAS_PLUGIN_NAME])
      expect(installation(name)).toBe("INSTALLED_BY_DEFAULT");
    expect(installation("moss-seedream")).toBe("AVAILABLE");

    const skillOf = (name: string) =>
      readFileSync(path.join(result.root, "plugins", name, "skills", name, "SKILL.md"), "utf8");
    const imageSkill = skillOf("moss-imagegen");
    expect(imageSkill).toContain("name: moss-imagegen");
    expect(imageSkill).toContain("even when no model is named");
    // Every image model the Canvas offers, with its cost in Moss credits; GPT Image 2.5 first.
    for (const model of MOSS_IMAGE_MODEL_IDS) expect(imageSkill).toContain(`\`${model}\``);
    expect(imageSkill).toContain("GPT Image 2.5 Flare（默认）");
    expect(imageSkill).toContain("1K/2K 约 95 积分/张");
    expect(imageSkill).toContain("用对方说话的语言回复");
    expect(imageSkill).toContain("不要重新提交");
    expect(imageSkill).toContain("moss_canvas_open");

    const videoSkill = skillOf("moss-videogen");
    for (const model of MOSS_VIDEO_MODEL_IDS) expect(videoSkill).toContain(`\`${model}\``);
    expect(videoSkill).toContain("即梦 Seedance 2.0 Fast（默认）");
    expect(videoSkill).toContain("description: Create videos with Moss");
    expect(videoSkill).toContain("不要把编辑悄悄变成纯文字生成");

    const seedance = skillOf("moss-seedance");
    expect(seedance).toContain("# 即梦视频");
    expect(seedance).toContain("这个技能只用于即梦 Seedance 的模型");
    expect(seedance).toContain("改用「生视频」技能");
    expect(seedance).not.toContain("`kling-v3-omni`");
    expect(skillOf("moss-nano-banana")).toContain("`gemini-flash-image`");
    for (const plugin of MOSS_MEDIA_PLUGINS.filter((plugin) => plugin.kind !== "canvas")) {
      const skill = skillOf(plugin.name);
      expect(skill).not.toMatch(/api[_ -]?key\s*[:=]/iu);
      expect(skill).toContain("参考价（Moss 积分）");
    }
    if (supportsPosixPermissions()) {
      expect(
        lstatSync(
          path.join(result.root, "plugins", "moss-imagegen", "skills", "moss-imagegen", "SKILL.md"),
        ).mode & 0o077,
      ).toBe(0);
    }
    expect(
      JSON.parse(
        readFileSync(
          path.join(result.root, "plugins", "moss-imagegen", ".codex-plugin", "plugin.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      interface: {
        displayName: "Image Generation",
        shortDescription: "Create and edit images with every Moss image model",
        defaultPrompt: ["Generate an image: "],
      },
    });
    expect(installation("moss-plugin-creator")).toBe("INSTALLED_BY_DEFAULT");
    const imageGuide = readFileSync(
      path.join(result.root, "plugins", "moss-imagegen", "skills", "moss-imagegen", "SKILL.md"),
      "utf8",
    );
    expect(imageGuide).toContain("拿到 jobId 后简短告知已提交，即可结束回复");
    expect(imageGuide).not.toContain("每 15 秒");
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

  it("leads with image, video and Canvas, installs Canvas by default, and ships it for every CLI format", () => {
    const result = materializeMossBundledPluginMarketplace(makeManagedHome());
    const marketplace = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(marketplace.plugins.slice(0, 3).map((plugin: { name: string }) => plugin.name)).toEqual([
      "moss-imagegen",
      "moss-videogen",
      MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
    ]);
    expect(
      marketplace.plugins.find(
        (plugin: { name: string }) => plugin.name === MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
      ),
    ).toMatchObject({
      policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE" },
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
    expect(skill).toContain("画布不是「资料空间」");
    expect(skill).toContain("`moss_canvas_open`");
    expect(skill).toContain("`moss_canvas_read`");
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
