// FILE: windows.test.ts
// Purpose: Verify Windows activity privacy boundaries and persistent protected keys.
// Layer: Computer History adapter tests

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { makeComputerHistoryService } from "./service.ts";
import {
  makeWindowsHistoryKeyProvider,
  parseWindowsHistorySample,
  startWindowsHistoryCollector,
} from "./windows.ts";

describe("Windows foreground history", () => {
  it.runIf(process.platform === "win32")(
    "selects the Windows adapter when desktop also supplies a macOS helper path",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "moss-windows-history-desktop-"));
      const service = makeComputerHistoryService({
        rootDir,
        helperPath: join(rootDir, "unused-appsnap-helper"),
        keychainNamespace: "moss-qa-desktop-history",
      });
      try {
        expect(await service.getState()).toMatchObject({
          supported: true,
          enabled: false,
          inputMonitoringPermission: "granted",
          accessibilityPermission: "granted",
          screenRecordingPermission: "granted",
        });
        expect(await service.listApplications()).toMatchObject({ applications: [] });
      } finally {
        await service.shutdown();
      }
    },
  );
  // This case needs a real foreground window, so it takes focus from whatever app is in front.
  // It never runs on a desktop someone is using: opt in with MOSS_TEST_REAL_FOREGROUND_WINDOW=1
  // on a dedicated Windows runner. Even then the window is parked off-screen, not TopMost and
  // out of the taskbar, so nothing appears on the screen.
  it.runIf(process.platform === "win32" && process.env.MOSS_TEST_REAL_FOREGROUND_WINDOW === "1")(
    "samples an owned real foreground window and stops its native collector",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "moss-history-native-window-"));
      const executable = join(root, "MossHistoryFixture.exe");
      const script = `
$ErrorActionPreference='Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly '${executable.replaceAll("'", "''")}' -OutputType WindowsApplication @'
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class MossHistoryFixture {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr unused);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint first, uint second, bool attach);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
 [STAThread] public static void Main() {
  Application.EnableVisualStyles();
  var form=new Form(); form.Text="Moss history isolated test"; form.Width=420; form.Height=150; form.StartPosition=FormStartPosition.Manual; form.Location=new System.Drawing.Point(-32000,-32000); form.ShowInTaskbar=false; form.TopMost=false;
  var label=new Label(); label.Text="Moss isolated history test window"; label.Dock=DockStyle.Fill; form.Controls.Add(label);
  var timer=new Timer(); timer.Interval=20000; timer.Tick+=(sender,e)=>form.Close(); timer.Start();
  form.Shown+=(sender,e)=>{
   var foreground=GetForegroundWindow(); var other=GetWindowThreadProcessId(foreground,IntPtr.Zero); var current=GetCurrentThreadId();
   var attached=other!=current && AttachThreadInput(current,other,true);
   SetForegroundWindow(form.Handle); form.Activate();
   if(attached) AttachThreadInput(current,other,false);
  }; Application.Run(form);
 }
}
'@
$fixture = Start-Process -FilePath '${executable.replaceAll("'", "''")}' -WindowStyle Normal -PassThru
$null = $fixture.WaitForInputIdle(5000)
[Console]::Out.Write($fixture.Id)
`;
      const { stdout: fixturePid } = await promisify(execFile)(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, timeout: 15_000 },
      );
      let seen = false;
      let failure = false;
      const stop = startWindowsHistoryCollector(
        (sample) => {
          if (sample.app.bundleIdentifier === "windows.mosshistoryfixture") {
            seen = true;
            expect(sample.window).toEqual({});
          }
        },
        () => {
          failure = true;
        },
      );
      try {
        await expect.poll(() => seen, { timeout: 11_000 }).toBe(true);
        expect(failure).toBe(false);
      } finally {
        await stop();
        // The fixture would otherwise hold the foreground for its full 20 s timer.
        try {
          process.kill(Number(fixturePid.trim()));
        } catch {
          // Already closed.
        }
      }
    },
    30_000,
  );
  it("keeps only app metadata and drops document titles and paths", () => {
    expect(
      parseWindowsHistorySample({
        processName: "notepad",
        displayName: "Notepad",
        windowClass: "Notepad",
        capturedAtMs: 1_700_000_000_000,
        title: "private draft",
        path: "C:/private",
      }),
    ).toEqual({
      app: { bundleIdentifier: "windows.notepad", name: "Notepad" },
      window: {},
      capturedAtMs: 1_700_000_000_000,
    });
  });
  it.each(["chrome", "msedge", "firefox", "brave", "qqbrowser", "zen", "360se"])(
    "excludes browser %s regardless of locale or window title",
    (processName) => {
      expect(
        parseWindowsHistorySample({
          processName,
          windowClass: "unknown",
          capturedAtMs: Date.now(),
        }),
      ).toBeNull();
    },
  );
  it("fails closed for unknown Chromium and UWP windows", () => {
    for (const windowClass of [
      "Chrome_WidgetWin_1",
      "MozillaWindowClass",
      "ApplicationFrameWindow",
    ]) {
      expect(
        parseWindowsHistorySample({
          processName: "unknown",
          windowClass,
          capturedAtMs: Date.now(),
        }),
      ).toBeNull();
    }
    expect(
      parseWindowsHistorySample({
        processName: "code",
        windowClass: "Chrome_WidgetWin_1",
        capturedAtMs: Date.now(),
      })?.app.bundleIdentifier,
    ).toBe("windows.code");
  });
  it.runIf(process.platform === "win32")(
    "restores the same DPAPI-protected key after reopening and destroys it on clear",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "moss-windows-history-key-"));
      const first = makeWindowsHistoryKeyProvider(root);
      const key = Buffer.from(await first.getOrCreateKey());
      expect(key.length).toBe(32);
      expect(await readFile(join(root, "key.dpapi"), "utf8")).not.toContain(key.toString("base64"));
      const reopened = makeWindowsHistoryKeyProvider(root);
      expect(await reopened.getOrCreateKey()).toEqual(key);
      await reopened.destroyKey?.();
      await expect(readFile(join(root, "key.dpapi"))).rejects.toMatchObject({ code: "ENOENT" });
      const replacement = await reopened.getOrCreateKey();
      expect(replacement.equals(key)).toBe(false);
      await reopened.destroyKey?.();
    },
    20_000,
  );
});
