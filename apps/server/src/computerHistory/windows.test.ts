// FILE: windows.test.ts
// Purpose: The real Windows helper: OCR on a fixture image, one synthetic window end to end,
//          adapter selection and the DPAPI-protected key.
// Layer: Computer History adapter tests (Windows-only cases skip elsewhere)

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { makeComputerHistoryService } from "./service.ts";
import { makeWindowsHistoryKeyProvider, startWindowsHistoryHelper } from "./windows.ts";
import { assessWindowsHistoryProbe, summarizeWindowsActivity } from "./windowsActivity.ts";

const onWindows = process.platform === "win32";
const OCR_FIXTURE = fileURLToPath(new URL("./fixtures/windows-ocr-code.png", import.meta.url));

// A small window the test owns. It is parked off every display, never activated and kept out
// of the taskbar, so the owner's screen and foreground window are never involved.
async function startSyntheticWindow(): Promise<{ hwnd: number; close: () => void }> {
  const root = await mkdtemp(join(tmpdir(), "moss-history-synthetic-"));
  const executable = join(root, "MossHistoryFixture.exe");
  const script = `
$ErrorActionPreference='Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly '${executable.replaceAll("'", "''")}' -OutputType WindowsApplication @'
using System;
using System.Drawing;
using System.Windows.Forms;
public class MossHistoryFixture : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
  public MossHistoryFixture() {
    Text = "Moss history fixture"; Width = 900; Height = 320; ShowInTaskbar = false; BackColor = Color.White;
    StartPosition = FormStartPosition.Manual; Location = new Point(-32000, -32000);
    var label = new Label(); label.Dock = DockStyle.Fill; label.Font = new Font("Consolas", 22); label.ForeColor = Color.Black;
    label.Text = "import { render } from view;\\nconst total = items.length;\\nfunction draw(items) {\\n  return total;\\n}";
    Controls.Add(label);
    var timer = new Timer(); timer.Interval = 30000; timer.Tick += delegate { Close(); }; timer.Start();
    Shown += delegate { Console.Out.WriteLine(Handle.ToInt64()); Console.Out.Flush(); };
  }
  [STAThread] public static void Main() { Application.Run(new MossHistoryFixture()); }
}
'@
`;
  await promisify(execFile)(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 30_000 },
  );
  const child = spawn(executable, [], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  const hwnd = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic window did not start.")), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /^(\d+)\s*$/mu.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return { hwnd, close: () => child.kill() };
}

describe("Windows Computer History helper", () => {
  it.runIf(onWindows)(
    "reads a fixture image with Windows OCR and summarizes it without its words",
    async () => {
      const helper = startWindowsHistoryHelper({ onExit: () => undefined, testTargets: true });
      try {
        const ready = await helper.ready;
        expect(ready).not.toBeNull();
        if (!ready?.ocr) return; // A Windows without any OCR language records app names only.
        const text = await helper.ocrFile(OCR_FIXTURE);
        expect(text).toMatch(/const total/u);
        expect(text).toMatch(/function draw/u);
        const summary = summarizeWindowsActivity({
          processName: "MossHistoryFixture.exe",
          displayName: "",
          focusedControl: null,
          ocrText: text,
        });
        expect(summary?.title).toBe("Writing code");
        expect(JSON.stringify(summary)).not.toMatch(/total|draw|render/u);
      } finally {
        await helper.stop();
      }
    },
    60_000,
  );

  it.runIf(onWindows)(
    "probes, frames and reads one synthetic window, and never the real foreground window",
    async () => {
      const window = await startSyntheticWindow();
      const helper = startWindowsHistoryHelper({ onExit: () => undefined, testTargets: true });
      try {
        const ready = await helper.ready;
        expect(ready).not.toBeNull();
        // Without a target the test helper reports nothing rather than the person's window.
        expect((await helper.probe())?.target).toBeNull();
        const probe = await helper.probe(window.hwnd);
        expect(probe?.target).toMatchObject({
          hwnd: window.hwnd,
          processName: "MossHistoryFixture.exe",
          title: "Moss history fixture",
          minimized: false,
          displayAffinity: 0,
        });
        expect(probe?.others).toEqual([]);
        expect(assessWindowsHistoryProbe(probe!)).toEqual({ allowed: true });
        const frame = await helper.capture("synthetic-1", window.hwnd);
        expect(frame?.fingerprint).toHaveLength(256);
        // A white window with dark text: mostly bright cells, some darker ones.
        expect(Math.max(...frame!.fingerprint)).toBeGreaterThan(200);
        if (!ready?.ocr) return;
        const text = await helper.ocr("synthetic-1");
        expect(text).toMatch(/total/u);
        // The frame is gone once read.
        expect(await helper.ocr("synthetic-1")).toBeNull();
        expect(
          summarizeWindowsActivity({
            processName: probe!.target!.processName,
            displayName: probe!.target!.displayName,
            focusedControl: probe!.target!.focusedControl,
            ocrText: text,
          })?.title,
        ).toBe("Writing code");
      } finally {
        await helper.stop();
        window.close();
      }
    },
    90_000,
  );

  it.runIf(onWindows)(
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
      } finally {
        await service.shutdown();
      }
    },
  );

  it.runIf(onWindows)(
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
