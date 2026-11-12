import { describe, expect, it } from "vitest";

import {
  computerAppAllowKeys,
  computerAppCanBeAlwaysAllowed,
  computerAppIdentityKeys,
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
    expect([...computerAppAllowKeys({ name: "Notepad" })]).toEqual(["notepad"]);
    expect(computerAppAllowKeys({ name: String.raw`C:\Users\me\Downloads\notepad.exe` }).size).toBe(
      0,
    );
    expect(computerAppAllowKeys({ name: "/tmp/Notes.app" }).size).toBe(0);
    expect([...computerAppAllowKeys({ name: "Notes", bundleId: "com.apple.Notes" })]).toEqual([
      "notes",
      "com.apple.notes",
    ]);
  });

  it("never lets Windows Settings, Control Panel or shared hosts skip the prompt", () => {
    for (const name of [
      "Settings",
      "SystemSettings.exe",
      "Control Panel",
      "control",
      "explorer",
      "File Explorer",
      "ApplicationFrameHost",
    ]) {
      expect(computerAppCanBeAlwaysAllowed(name), name).toBe(false);
      expect(computerAppAllowKeys({ name }).size, name).toBe(0);
    }
    // A window naming an ordinary app but owned by a never-allowed process answers nothing.
    expect(computerAppAllowKeys({ name: "Calculator", bundleId: "explorer" }).size).toBe(0);
    expect(computerAppCanBeAlwaysAllowed("Notepad")).toBe(true);
    expect(computerAppCanBeAlwaysAllowed(String.raw`C:\x\notepad.exe`)).toBe(false);
  });

  it("recognises the Windows processes that host many apps' windows", () => {
    expect(computerAppIsSharedHost("ApplicationFrameHost.exe")).toBe(true);
    expect(computerAppIsSharedHost("explorer")).toBe(true);
    expect(computerAppIsSharedHost("notepad")).toBe(false);
  });
});
