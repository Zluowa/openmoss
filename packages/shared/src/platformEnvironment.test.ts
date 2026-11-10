import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  configuredHomeDirectory,
  normalizeEnvironmentKeys,
  resolveApplicationDirectory,
  resolveWindowsComSpec,
  withWindowsPowerShellModules,
  resolveWindowsPowerShellExecutable,
  resolveWindowsSystemExecutable,
  resolveWindowsSystemRoot,
  resolveWindowsWslExecutable,
} from "./platformEnvironment";

describe("platformEnvironment", () => {
  it.each([
    ["win32", ["AppData", "Roaming", "Cursor"], ["AppData", "Roaming", "Devin"]],
    ["darwin", ["Library", "Application Support", "Cursor"], [".local", "share", "devin"]],
    ["linux", [".config", "Cursor"], [".local", "share", "devin"]],
  ] as const)("uses the native app directory conventions on %s", (platform, cursor, devin) => {
    const roots = { platform, homeDir: "/home/local" };
    const desktop = { ...roots, kind: "desktop-config", name: "Cursor" } as const;
    const cli = { ...roots, kind: "cli-data", name: "Devin", xdgName: "devin" } as const;
    expect(resolveApplicationDirectory(desktop)).toBe(join(roots.homeDir, ...cursor));
    expect(resolveApplicationDirectory(cli)).toBe(join(roots.homeDir, ...devin));
    const env = { roamingAppData: "/roaming", xdgHome: "/xdg" };
    expect(resolveApplicationDirectory({ ...desktop, ...env })).toBe(
      platform === "win32"
        ? join("/roaming", "Cursor")
        : platform === "darwin"
          ? join(roots.homeDir, ...cursor)
          : join("/xdg", "Cursor"),
    );
    expect(resolveApplicationDirectory({ ...cli, ...env })).toBe(
      platform === "win32" ? join("/roaming", "Devin") : join("/xdg", "devin"),
    );
  });

  it("prioritizes built-in Windows PowerShell modules without changing the parent environment", () => {
    const env = { SystemRoot: "C:\\Windows", PSModulePath: "C:\\PowerShell7;C:\\Custom" };
    const result = withWindowsPowerShellModules(env);
    expect(result.PSModulePath).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;C:\\PowerShell7;C:\\Custom",
    );
    expect(env.PSModulePath).toBe("C:\\PowerShell7;C:\\Custom");
  });
  it("uses the hydrated Windows environment before stable system defaults", () => {
    const env = {
      SystemRoot: "D:\\Windows",
      ComSpec: "D:\\Windows\\System32\\custom-cmd.exe",
    };

    expect(resolveWindowsSystemRoot(env)).toBe("D:\\Windows");
    expect(resolveWindowsComSpec(env)).toBe("D:\\Windows\\System32\\custom-cmd.exe");
    expect(resolveWindowsWslExecutable(env)).toBe("D:\\Windows\\System32\\wsl.exe");
    expect(resolveWindowsPowerShellExecutable(env)).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("builds system executable paths without consulting PATH", () => {
    expect(
      resolveWindowsSystemExecutable(["System32", "tool.exe"], { SYSTEMROOT: "C:\\WIN" }),
    ).toBe("C:\\WIN\\System32\\tool.exe");
  });
});

it("uses the configured home and Windows case-insensitive environment keys", () => {
  const configured = { Home: " D:/home ", UserProfile: "D:/profile" };
  expect(configuredHomeDirectory(normalizeEnvironmentKeys(configured, "win32"), "win32")).toBe(
    "D:/home",
  );
  expect(
    configuredHomeDirectory(
      normalizeEnvironmentKeys({ UserProfile: "D:/profile" }, "win32"),
      "win32",
    ),
  ).toBe("D:/profile");
  expect(
    configuredHomeDirectory(normalizeEnvironmentKeys(configured, "linux"), "linux"),
  ).toBeUndefined();
});
