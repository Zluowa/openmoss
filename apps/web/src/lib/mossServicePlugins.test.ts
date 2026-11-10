import { mossServiceSkillMarkdown } from "@moss/shared/mossServicePlugins";
import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "~/localization/zhCN";
import {
  isMossServicePlugin,
  MOSS_SERVICE_PLUGINS_MARKETPLACE_NAME,
  mossServicePluginDescriptor,
  mossServicePluginDetail,
  mossServicePluginDirectoryEntries,
  mossServicePluginFromPluginId,
  mossServicePluginId,
  mossServicePluginSkillReference,
  mossServiceSkillPreview,
} from "./mossServicePlugins";
import { isMossOfficialMarketplace, sectionCodexPluginDirectory } from "./pluginLibraryModel";

describe("mossServicePlugins", () => {
  it("lists mainland China plugins only for the cn region, installed first", () => {
    expect(mossServicePluginDirectoryEntries({ region: "global", installed: new Set() })).toEqual(
      [],
    );
    const entries = mossServicePluginDirectoryEntries({
      region: "cn",
      installed: new Set(["didi", "flyai"]),
    });
    // Luckin stays hidden until its sign-in is verified.
    expect(entries.map((entry) => entry.plugin.name)).toEqual([
      "didi",
      "flyai",
      "amap",
      "baidu_maps",
      "tencent_maps",
      "mcdonalds_cn",
      "taobao",
    ]);
    expect(entries.slice(0, 2).every((entry) => entry.plugin.installed)).toBe(true);
    expect(
      entries.every((entry) => entry.marketplaceName === MOSS_SERVICE_PLUGINS_MARKETPLACE_NAME),
    ).toBe(true);
  });

  it("shows one plugin bundling the skill and the MCP server", () => {
    const amap = mossServicePluginFromPluginId(mossServicePluginId("amap"))!;
    const detail = mossServicePluginDetail(amap, true, (text) => `zh:${text}`);
    expect(detail.skills.map((skill) => skill.name)).toEqual(["amap-maps"]);
    expect(detail.mcpServers).toEqual(["amap_connector"]);
    expect(detail.summary.installed).toBe(true);
    expect(detail.description?.startsWith("zh:")).toBe(true);
    expect(isMossServicePlugin({ id: "amap@moss-apps" })).toBe(false);
  });

  it("previews a plugin's skill from Moss's own text, installed or not", () => {
    const amap = mossServicePluginFromPluginId(mossServicePluginId("amap"))!;
    const [skill] = mossServicePluginDetail(amap, false).skills;
    expect(mossServiceSkillPreview(skill!.path)).toEqual({
      contents: mossServiceSkillMarkdown(amap),
    });
    // Anything else still goes to the CLI's own skill reader.
    expect(mossServiceSkillPreview("/home/me/.moss/skills/amap-maps/SKILL.md")).toBeNull();
    expect(
      mossServiceSkillPreview("moss-service-plugin://luckin/luckin-coffee-order/SKILL.md"),
    ).toBe(null);
    expect(mossServiceSkillPreview("moss-service-plugin://amap/didi-ride/SKILL.md")).toBeNull();
  });

  it("finds the installed skill file a chat attaches for a service plugin", () => {
    const skills = [
      { pluginId: "amap", name: "amap-maps", path: "/home/me/.moss/skills/amap-maps/SKILL.md" },
    ];
    expect(mossServicePluginSkillReference({ id: mossServicePluginId("amap") }, skills)).toEqual({
      name: "amap-maps",
      path: "/home/me/.moss/skills/amap-maps/SKILL.md",
    });
    expect(mossServicePluginSkillReference({ id: mossServicePluginId("didi") }, skills)).toBeNull();
    expect(mossServicePluginSkillReference({ id: "amap@moss-apps" }, skills)).toBeNull();
  });

  it("lists the MCP server rather than a separate app row", () => {
    const didi = mossServicePluginFromPluginId(mossServicePluginId("didi"))!;
    expect(mossServicePluginDetail(didi, false).apps).toEqual([]);
  });

  it("gives a skill-only plugin no MCP server and states what it needs", () => {
    const taobao = mossServicePluginFromPluginId(mossServicePluginId("taobao"))!;
    const detail = mossServicePluginDetail(taobao, false);
    expect(detail.mcpServers).toEqual([]);
    expect(detail.skills.map((skill) => skill.name)).toEqual(["taobao-shopping"]);
    expect(detail.description).toContain("Taobao desktop app");
    expect(detail.description).not.toMatch(/mcporter/iu);
  });

  it("reads the plugin copy and the server's errors in Chinese", () => {
    const taobao = mossServicePluginFromPluginId(mossServicePluginId("taobao"))!;
    const descriptor = mossServicePluginDescriptor(taobao, false, translateZhCnPresentationText);
    expect(descriptor.interface?.longDescription).toBe(
      "在淘宝搜索商品、加入购物车、查订单、联系卖家。每次改动前都先问你，从不付款。\n\n" +
        "需要这台电脑上已登录淘宝桌面客户端。第一次使用时，智能体会请你安装一个小的命令行工具。",
    );
    expect(translateZhCnPresentationText("This plugin is not available.")).toBe(
      "这个插件暂不可用。",
    );
    expect(translateZhCnPresentationText("Moss could not update this plugin.")).toBe(
      "Moss 无法更新这个插件。",
    );
  });

  it("joins the Moss Apps section ahead of the hosted catalog, not the official one", () => {
    expect(isMossOfficialMarketplace(MOSS_SERVICE_PLUGINS_MARKETPLACE_NAME)).toBe(false);
    const sections = sectionCodexPluginDirectory({
      entries: mossServicePluginDirectoryEntries({ region: "cn", installed: new Set() }),
    });
    expect(sections.map((section) => section.kind)).toEqual(["apps"]);
  });
});
