import "../index.css";
import "./PluginLibrary.css";

import { MOSS_DEVELOPER_PLUGIN_ID } from "@moss/shared/mossDeveloperPlugin";
import { MOSS_GUIDE_PLUGIN_ID } from "@moss/shared/mossGuidePlugin";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginLibraryNativeFixture, mountPluginLibrary } from "~/test/pluginLibraryBrowserHarness";

const mountedPages: Array<Awaited<ReturnType<typeof mountPluginLibrary>>> = [];

afterEach(async () => {
  while (mountedPages.length > 0) await mountedPages.pop()!.cleanup();
  vi.restoreAllMocks();
});

describe("PluginLibrary Moss 使用手册 official plugin", () => {
  it("lists Moss 使用手册 in the Official section, previews its skills, uninstalls, and reinstalls", async () => {
    const fixture = new PluginLibraryNativeFixture("populated");
    const mounted = await mountPluginLibrary({ fixture, locale: "zh-CN" });
    mountedPages.push(mounted);

    await expect
      .poll(() => document.body.textContent, { timeout: 3_000 })
      .toContain("Moss 使用手册");
    expect(document.body.textContent).toContain("生图");
    expect(document.body.textContent).toContain("生视频");
    expect(document.body.textContent).toContain("画布");

    await page.getByRole("button", { name: "Moss 使用手册", exact: true }).first().click();

    await expect
      .poll(() => document.body.textContent, { timeout: 3_000 })
      .toContain("Moss 全局使用手册");
    expect(document.body.textContent).toContain("主动插件发现与推荐");

    await userEvent.click(page.getByRole("button", { name: "更多操作" }));
    await userEvent.click(page.getByRole("menuitem", { name: "卸载" }));
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "卸载" }));

    await expect
      .poll(() => fixture.serverSettings.officialPlugins?.uninstalled ?? [], { timeout: 3_000 })
      .toContain(MOSS_GUIDE_PLUGIN_ID);

    // Re-open the uninstalled plugin and install it back cleanly.
    await expect
      .poll(() => document.body.textContent, { timeout: 3_000 })
      .toContain("Moss 使用手册");
    expect(document.body.textContent).toContain("生图");
    expect(document.body.textContent).toContain("生视频");
    expect(document.body.textContent).toContain("画布");
    await page.getByRole("button", { name: "Moss 使用手册", exact: true }).first().click();
    await page.getByRole("button", { name: "安装" }).first().click();

    await expect
      .poll(() => fixture.serverSettings.officialPlugins?.uninstalled ?? [], { timeout: 3_000 })
      .not.toContain(MOSS_GUIDE_PLUGIN_ID);
  });

  it("lists Moss 开发者 in the Official section, previews its skill, uninstalls, and reinstalls", async () => {
    const fixture = new PluginLibraryNativeFixture("populated");
    const mounted = await mountPluginLibrary({ fixture, locale: "zh-CN" });
    mountedPages.push(mounted);

    await expect.poll(() => document.body.textContent, { timeout: 3_000 }).toContain("Moss 开发者");

    await page.getByRole("button", { name: "Moss 开发者", exact: true }).first().click();
    await expect
      .poll(() => document.body.textContent, { timeout: 3_000 })
      .toContain("一句话零外部密钥打造 Moss 应用页");

    await userEvent.click(page.getByRole("button", { name: "更多操作" }));
    await userEvent.click(page.getByRole("menuitem", { name: "卸载" }));
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "卸载" }));

    await expect
      .poll(() => fixture.serverSettings.officialPlugins?.uninstalled ?? [], { timeout: 3_000 })
      .toContain(MOSS_DEVELOPER_PLUGIN_ID);

    await expect.poll(() => document.body.textContent, { timeout: 3_000 }).toContain("Moss 开发者");
    await page.getByRole("button", { name: "Moss 开发者", exact: true }).first().click();
    await page.getByRole("button", { name: "安装" }).first().click();

    await expect
      .poll(() => fixture.serverSettings.officialPlugins?.uninstalled ?? [], { timeout: 3_000 })
      .not.toContain(MOSS_DEVELOPER_PLUGIN_ID);
  });
});
