import { describe, expect, it } from "vitest";

import {
  alwaysAllowCandidates,
  buildComputerAppRows,
  nextComputerAppPolicy,
} from "./ComputerAppControls.logic";

// What a Chinese Windows reports: localized names, real executables underneath.
const USED = [
  { name: "记事本", processName: "notepad", iconPath: String.raw`C:\Windows\System32\notepad.exe` },
  {
    name: "设置",
    processName: "SystemSettings",
    iconPath: String.raw`C:\Windows\ImmersiveControlPanel\SystemSettings.exe`,
  },
  { name: "控制面板", processName: "control" },
  { name: "文件资源管理器", processName: "explorer" },
  // A name no list knows, but the executable is Windows Settings.
  { name: "Einstellungen", processName: "SystemSettings" },
  { name: "命令提示符", processName: "cmd" },
  // Nothing but a name: the desktop never said what it is.
  { name: "Mystery" },
  { name: "WeChat", processName: "WeChat" },
];

describe("ComputerAppControls.logic", () => {
  it("offers only ordinary apps with a known identity, whatever language they show", () => {
    const rows = buildComputerAppRows(USED, { blockedApps: ["WeChat"], alwaysAllowedApps: [] });
    expect(alwaysAllowCandidates(rows).map((row) => row.name)).toEqual(["记事本"]);
  });

  it("shows a saved choice for a protected program as not allowed", () => {
    const rows = buildComputerAppRows(USED, {
      blockedApps: [],
      alwaysAllowedApps: ["设置", "Einstellungen", "Mystery", "记事本"],
    });
    const allowed = Object.fromEntries(rows.map((row) => [row.name, row.alwaysAllowed]));
    expect(allowed).toMatchObject({
      设置: false,
      Einstellungen: false,
      Mystery: false,
      记事本: true,
    });
  });

  it("never treats a settings-only entry as allowable", () => {
    const rows = buildComputerAppRows([], { blockedApps: [], alwaysAllowedApps: ["Notepad"] });
    expect(rows).toMatchObject([{ name: "Notepad", allowable: false, alwaysAllowed: false }]);
    expect(alwaysAllowCandidates(rows)).toEqual([]);
  });

  it("turning an app off takes it out of always allowed", () => {
    expect(
      nextComputerAppPolicy(
        { blockedApps: [], alwaysAllowedApps: ["Notepad"] },
        { kind: "blocked", app: "notepad", value: true },
      ),
    ).toEqual({ blockedApps: ["notepad"], alwaysAllowedApps: [] });
  });
});
