// FILE: PluginAuthOnboarding.contract.test.ts
// Purpose: Prevents the pre-parity generic AlertDialog implementation from returning.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PluginLibrary auth onboarding production wiring", () => {
  it("uses the regular frozen-style onboarding dialog and preserves authPolicy", () => {
    const source = readFileSync(new URL("./PluginLibrary.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("Connect required apps");
    expect(source).not.toContain(
      "The plugin is installed, but it is not ready until you connect the required apps.",
    );
    expect(source).toContain("<PluginRequiredAppsDialog");
    expect(source).toContain("result.authPolicy");
    expect(source).toContain("openDetail(resource)");
    expect(source).toContain("handleTryInChat(resource)");
    expect(source.replace(/\s+/g, " ")).toContain(
      "showManagement || pluginAuthSetup !== null || connectTarget !== null",
    );
  });

  it("offers the frozen Try now action when install completes without immediate setup", () => {
    const source = readFileSync(new URL("./PluginLibrary.tsx", import.meta.url), "utf8");
    const localization = readFileSync(new URL("../localization.tsx", import.meta.url), "utf8");

    expect(source).toContain('format("plugins.install.success", { pluginName: resourceName })');
    expect(source).toContain('children: t("plugins.install.tryInChatToast")');
    expect(source).toContain("actionProps:");
    expect(localization).toContain('"plugins.install.success": "{pluginName} plugin installed"');
    expect(localization).toContain('"plugins.install.success": "{pluginName} 插件已安装"');
    expect(localization).toContain('"plugins.install.tryInChatToast": "Try now"');
    expect(localization).toContain('"plugins.install.tryInChatToast": "立即试用"');
  });

  it("localizes OAuth completion failures and wires callback recovery", () => {
    const source = readFileSync(new URL("./PluginLibrary.tsx", import.meta.url), "utf8");
    const localization = readFileSync(new URL("../localization.tsx", import.meta.url), "utf8");

    expect(source).not.toContain('title: "Failed to complete app connection"');
    expect(source).toContain('t("plugins.installModal.appConnectionCompleteFailed")');
    expect(source).toContain("onAppConnectionFailed");
    expect(source).toContain("pluginAuthSetup?.sessionId ?? retainedPluginAuthSession");
    expect(source).toContain("retainedPluginAuthSessionId({");
    expect(localization).toContain(
      '"plugins.installModal.appConnectionCompleteFailed": "Failed to complete app connection"',
    );
    expect(localization).toContain(
      '"plugins.installModal.appConnectionCompleteFailed": "无法完成应用连接"',
    );
  });
});
