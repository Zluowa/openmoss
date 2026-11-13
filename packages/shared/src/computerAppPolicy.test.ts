import { describe, expect, it } from "vitest";

import {
  computerAppAllowKeys,
  computerAppCanBeAlwaysAllowed,
  computerAppIdentityKeys,
  computerAppIsProtected,
  computerAppIsSharedHost,
  computerAppPolicyKey,
  computerAppPolicyMatch,
  withComputerApp,
  withoutComputerApp,
} from "./computerAppPolicy";

describe("computerAppPolicy", () => {
  it("reduces names, executables and bundles to one key", () => {
    expect(computerAppPolicyKey("Google Chrome")).toBe("google chrome");
    expect(
      computerAppPolicyKey(String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`),
    ).toBe("chrome");
    expect(computerAppPolicyKey("/Applications/Notes.app")).toBe("notes");
    expect(computerAppPolicyKey("  Visual   Studio Code ")).toBe("visual studio code");
  });

  it("matches exact keys only, never a prefix", () => {
    const keys = computerAppIdentityKeys({ name: "Chrome Remote Desktop" });
    expect(computerAppPolicyMatch(["Chrome"], keys)).toBeUndefined();
    expect(
      computerAppPolicyMatch(
        ["chrome"],
        computerAppIdentityKeys({ path: String.raw`D:\x\CHROME.EXE` }),
      ),
    ).toBe("chrome");
    expect(computerAppPolicyMatch(["chrome"], new Set())).toBeUndefined();
  });

  it("adds once and removes every spelling", () => {
    expect(withComputerApp(["Notepad"], "notepad")).toEqual(["Notepad"]);
    expect(withComputerApp(["Notepad"], " WeChat ")).toEqual(["Notepad", "WeChat"]);
    expect(withComputerApp([], "   ")).toEqual([]);
    expect(withoutComputerApp(["Notepad", "WeChat"], "NOTEPAD")).toEqual(["WeChat"]);
  });

  it("lets always-allowed match only an app's own name or bundle id, never a path", () => {
    expect([...computerAppAllowKeys({ name: "Notepad", processName: "notepad" })]).toEqual([
      "notepad",
    ]);
    expect(
      computerAppAllowKeys({
        name: String.raw`C:\Users\me\Downloads\notepad.exe`,
        processName: "notepad",
      }).size,
    ).toBe(0);
    expect(computerAppAllowKeys({ name: "/tmp/Notes.app", bundleId: "com.apple.Notes" }).size).toBe(
      0,
    );
    expect([...computerAppAllowKeys({ name: "Notes", bundleId: "com.apple.Notes" })]).toEqual([
      "notes",
      "com.apple.notes",
    ]);
  });

  it("needs an identity: a bare name, in any language, is never always-allowable", () => {
    for (const name of ["Notepad", "记事本", "Photoshop"]) {
      expect(computerAppCanBeAlwaysAllowed({ name }), name).toBe(false);
      expect(computerAppAllowKeys({ name }).size, name).toBe(0);
    }
  });

  it("protects Settings, Control Panel, shells and shared hosts by executable, whatever the name", () => {
    const protectedPrograms = [
      { name: "设置", processName: "SystemSettings" },
      { name: "設定", path: String.raw`C:\Windows\ImmersiveControlPanel\SystemSettings.exe` },
      { name: "Einstellungen", processName: "SystemSettings" },
      { name: "控制面板", processName: "control" },
      { name: "文件资源管理器", processName: "explorer" },
      { name: "計算機", processName: "ApplicationFrameHost" },
      { name: "注册表编辑器", processName: "regedit" },
      { name: "任务管理器", processName: "Taskmgr" },
      { name: "命令提示符", processName: "cmd" },
      { name: "Windows PowerShell", processName: "powershell" },
      { name: "终端", processName: "WindowsTerminal" },
      { name: "Terminal", bundleId: "com.apple.Terminal" },
    ];
    for (const identity of protectedPrograms) {
      expect(computerAppIsProtected(identity), identity.name).toBe(true);
      expect(computerAppCanBeAlwaysAllowed(identity), identity.name).toBe(false);
      expect(computerAppAllowKeys(identity).size, identity.name).toBe(0);
    }
  });

  it("keeps a display-name second net in English and Chinese", () => {
    // Even with an ordinary-looking identity, these names are never allowed.
    for (const name of [
      "Settings",
      "设置",
      "設定",
      "控制面板",
      "控制台",
      "檔案總管",
      "任务管理器",
    ]) {
      expect(computerAppCanBeAlwaysAllowed({ name, processName: "someapp" }), name).toBe(false);
    }
  });

  it("still allows an ordinary app with a Chinese name and a known executable", () => {
    expect(computerAppCanBeAlwaysAllowed({ name: "记事本", processName: "notepad" })).toBe(true);
    expect([...computerAppAllowKeys({ name: "记事本", processName: "notepad" })]).toEqual([
      "记事本",
    ]);
    expect(
      computerAppCanBeAlwaysAllowed({
        name: "微信",
        path: String.raw`C:\Program Files\Tencent\WeChat\WeChat.exe`,
      }),
    ).toBe(true);
  });

  it("recognises the Windows processes that host many apps' windows", () => {
    expect(computerAppIsSharedHost("ApplicationFrameHost.exe")).toBe(true);
    expect(computerAppIsSharedHost("explorer")).toBe(true);
    expect(computerAppIsSharedHost("notepad")).toBe(false);
  });
});
