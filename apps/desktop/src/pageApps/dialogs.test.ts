import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getDisplayMatching: vi.fn(() => ({ workArea: { height: 900 } })) },
}));

import {
  buildAboutDialogSpec,
  buildErrorDialogSpec,
  buildInstallConfirmDialogSpec,
  buildPermissionRequestDialogSpec,
  buildPermissionsManagerDialogSpec,
  buildReloadConfirmDialogSpec,
  buildUninstallConfirmDialogSpec,
  renderPageAppDialogHtml,
} from "./dialogs";

describe("dialogs", () => {
  it("renders install confirm modal in Simplified Chinese with autofocus, aria-describedby, forced-colors, and full 500ms cooldown", () => {
    const spec = buildInstallConfirmDialogSpec({ appName: "轨道追踪器" });
    expect(spec.size).toBe("md");
    expect(spec.title).toBe("将“轨道追踪器”安装为应用？");
    expect(spec.badge).toBe("测试版");
    expect(spec.body).toContain(
      "如果继续，“轨道追踪器”将作为独立程序安装，拥有独立窗口和用于打开它的快捷方式。未经您的允许，它无法访问您的文件或运行程序。",
    );
    const html = renderPageAppDialogHtml(spec, { dark: true, cooldownMs: 500 });
    expect(html).toContain("theme-dark");
    expect(html).toContain("--bg: #ffffff;");
    expect(html).toContain("button:focus:not(:focus-visible) { outline: none; }");
    expect(html).toContain("::-webkit-scrollbar { display: none; }");
    expect(html).toContain("@media (forced-colors: active)");
    expect(html).toContain("animation-timeline: scroll()");
    expect(html).toContain('autofocus aria-describedby="body"');
    expect(html).toContain("event.preventDefault();");
    expect(html).toContain('event.key === "Tab"');
    expect(html).toContain("buttons.length > 1");
    expect(html).toContain("__measureMossDialog");
    expect(html).toContain("COOLDOWN_MS = 500");
    expect(html).toContain("nonce: ++submitNonce");
    expect(html).toContain("__MOSS_DIALOG_RESULT__:");
    expect(html).toContain("取消");
    expect(html).toContain("安装");
  });

  it("renders Tier 3 dialogs across owner / workspace / external / untrusted trust levels", () => {
    const ownerSpec = buildPermissionRequestDialogSpec({
      appName: "个人笔记本",
      permission: "full-access",
      trustKind: "owner",
    });
    expect(ownerSpec.size).toBe("sm");
    expect(ownerSpec.warningTone).toBeUndefined();
    expect(ownerSpec.buttons.find((b) => b.id === "allow")?.role).toBe("primary");

    const wsSpec = buildPermissionRequestDialogSpec({
      appName: "团队看板",
      permission: "full-access",
      trustKind: "workspace",
    });
    expect(wsSpec.size).toBe("md");
    expect(wsSpec.warningTone).toBe("yellow");
    expect(wsSpec.buttons.find((b) => b.id === "allow")?.role).toBe("primary");

    const extSpec = buildPermissionRequestDialogSpec({
      appName: "桌面终端",
      permission: "full-access",
      trustKind: "external",
      isReapproval: true,
    });
    expect(extSpec.title).toBe("是否继续允许 “桌面终端” 在此电脑上运行命令？");
    expect(extSpec.reapprovalBanner).toContain("自您授予此权限以来，此应用页已有更新");
    expect(extSpec.warningTone).toBe("red");
    expect(extSpec.checkboxLabel).toBe("我了解此应用未经 Moss 审核。");
    expect(extSpec.buttons.find((b) => b.id === "allow")?.role).toBe("danger");

    const extHtml = renderPageAppDialogHtml(extSpec);
    expect(extHtml).toContain('id="ack-checkbox" type="checkbox" role="switch" required');
    expect(extHtml).toContain('class="row warn"');
    expect(extHtml).toContain('<svg width="20" height="20"');

    const extTier2 = buildPermissionRequestDialogSpec({
      appName: "外部悬浮窗",
      permission: "overlay",
      trustKind: "external",
    });
    expect(extTier2.warningTone).toBe("red");

    const untrustedTier3 = buildPermissionRequestDialogSpec({
      appName: "未知应用",
      permission: "full-access",
      trustKind: "untrusted",
    });
    expect(untrustedTier3.size).toBe("sm");
    expect(untrustedTier3.buttons).toHaveLength(1);
    expect(untrustedTier3.buttons[0]?.label).toBe("好");
  });

  it("renders permissions manager with data-follows linkage, hidden undeclared items, and 0-permission single button view", () => {
    const mgr = buildPermissionsManagerDialogSpec({
      appName: "桌面计时器",
      hasActiveRunningApp: true,
      items: [
        { permission: "notifications", state: "prompt", declared: true },
        { permission: "shortcuts", state: "prompt", declared: true },
        { permission: "overlay", state: "denied", declared: true },
        { permission: "menu-bar", state: "unavailable", declared: false },
        { permission: "full-access", state: "prompt", declared: true },
      ],
    });
    // menu-bar is undeclared/unavailable -> hidden
    expect(mgr.permissionToggles).toHaveLength(4);
    const html = renderPageAppDialogHtml(mgr);
    expect(html).toContain('role="switch" class="perm-switch" data-permission="full-access"');
    expect(html).toContain('data-follows="3"');
    expect(html).toContain('data-explicit-denied="1"');
    expect(html).not.toContain('data-permission="menu-bar"');

    const emptyMgr = buildPermissionsManagerDialogSpec({
      appName: "纯展示页",
      items: [{ permission: "notifications", state: "unavailable", declared: false }],
    });
    expect(emptyMgr.permissionToggles).toHaveLength(0);
    expect(emptyMgr.buttons).toHaveLength(1);
    expect(emptyMgr.buttons[0]?.label).toBe("好");

    const reload = buildReloadConfirmDialogSpec({ appName: "桌面计时器" });
    expect(reload.size).toBe("sm");
    expect(reload.title).toBe("要重新加载 “桌面计时器” 吗？");
    expect(reload.body).toContain("尚未保存的更改可能会丢失");

    const uninstallOpen = buildUninstallConfirmDialogSpec({ appName: "桌面计时器", isOpen: true });
    expect(uninstallOpen.body).toContain("此窗口也会随之关闭");
    expect(uninstallOpen.body).toContain("取消固定");

    const errSpec = buildErrorDialogSpec({ title: "无法安装", body: "快捷方式写入失败" });
    expect(renderPageAppDialogHtml(errSpec)).toContain('class="tile"');

    const aboutSpec = buildAboutDialogSpec({
      appName: "桌面计时器",
      appId: "app-1",
      revision: 3,
      referenceText: "http://127.0.0.1/apps/app-1",
      attribution: "由您创建的应用页。",
      whenText: "最近更新于 2026 年 11 月 26 日。",
    });
    expect(aboutSpec.body).toContain("由您创建的应用页。");
    expect(aboutSpec.body).toContain("最近更新于");
  });
});
