// FILE: windows.ts
// Purpose: Windows Computer History helper (foreground window probe, one-window frame, Windows
//          OCR, installed-app catalog) and DPAPI-protected local encryption keys.
// Layer: Computer History operating-system adapter
// Exports: makeWindowsHistoryKeyProvider, startWindowsHistoryHelper, WINDOWS_HISTORY_BROWSER_CAPABILITIES

import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { guardChildStdio } from "@moss/shared/jsonrpc-stdio";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComputerHistoryKeyProvider } from "./store.ts";
import {
  parseWindowsHistoryFingerprint,
  parseWindowsHistoryProbe,
  WINDOWS_HISTORY_BROWSER_EXECUTABLES,
  WINDOWS_HISTORY_OCR_MAX_LENGTH,
  type WindowsHistoryProbe,
} from "./windowsActivity.ts";

export const WINDOWS_HISTORY_BROWSER_CAPABILITIES = WINDOWS_HISTORY_BROWSER_EXECUTABLES.map(
  (name) => ({
    bundleIdentifier: `${name}.exe`,
    name,
    status: "unsupported" as const,
    detail: "Windows browser activity is excluded because private browsing cannot be verified.",
  }),
);

function powershellScript(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) reject(new Error("Windows could not unlock the local history key."));
        else resolve(stdout.trim());
      },
    );
    // PowerShell can exit before reading its input; its exit code reports that.
    guardChildStdio(child);
    child.stdin?.end(input);
  });
}

const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bytes = [Convert]::FromBase64String($request.data)
$entropy = [Text.Encoding]::UTF8.GetBytes('Moss Computer History v1')
if ($request.action -eq 'protect') {
  $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[Console]::Out.Write([Convert]::ToBase64String($result))
`;

export function makeWindowsHistoryKeyProvider(rootDir: string): ComputerHistoryKeyProvider {
  const path = join(rootDir, "key.dpapi");
  let pending: Promise<Buffer> | undefined;
  const load = async (): Promise<Buffer> => {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    let protectedKey: string;
    try {
      protectedKey = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      protectedKey = await powershellScript(
        DPAPI_SCRIPT,
        JSON.stringify({ action: "protect", data: key.toString("base64") }),
      );
      key.fill(0);
      try {
        await writeFile(path, protectedKey, { flag: "wx", mode: 0o600 });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        protectedKey = await readFile(path, "utf8");
      }
    }
    const key = Buffer.from(
      await powershellScript(
        DPAPI_SCRIPT,
        JSON.stringify({ action: "unprotect", data: protectedKey }),
      ),
      "base64",
    );
    if (key.length !== 32) throw new Error("Windows returned an invalid local history key.");
    return key;
  };
  return {
    getOrCreateKey() {
      pending ??= load().catch((error) => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
    async destroyKey() {
      const existing = pending;
      pending = undefined;
      if (existing)
        await existing.then(
          (key) => key.fill(0),
          () => undefined,
        );
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

// The helper is Windows PowerShell 5.1 (present on every supported Windows) hosting a small
// C# type. Frames never leave this process: `capture` keeps one in memory under its request
// id and returns only a 16x16 grayscale fingerprint; `ocr` reads that frame with
// Windows.Media.Ocr and returns bounded text; `drop` discards it. PrintWindow renders only the
// target window, so no other window can appear in a frame. stdin closing (Moss exiting) ends it.
const HELPER_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class MossHistoryNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p, int f, StringBuilder s, ref int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);

  static readonly Dictionary<uint, string[]> processes = new Dictionary<uint, string[]>();
  static volatile bool uiaBusy;

  public static void Init() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
    try { SetProcessDPIAware(); } catch {}
  }
  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
  public static uint ProcessId(long h) { uint pid; GetWindowThreadProcessId(new IntPtr(h), out pid); return pid; }
  public static string ClassName(long h) { var s = new StringBuilder(256); GetClassName(new IntPtr(h), s, 256); return s.ToString(); }
  public static string Title(long h) { var s = new StringBuilder(1024); GetWindowText(new IntPtr(h), s, 1024); return s.ToString(); }
  public static bool Minimized(long h) { return IsIconic(new IntPtr(h)); }
  public static bool Cloaked(long h) { int v = 0; return DwmGetWindowAttribute(new IntPtr(h), 14, out v, 4) == 0 && v != 0; }
  public static int Affinity(long h) { uint a = 0; return GetWindowDisplayAffinity(new IntPtr(h), out a) ? (int)a : 0; }
  public static double IdleSeconds() {
    var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return -1;
    return unchecked(GetTickCount() - i.dwTime) / 1000.0;
  }
  static string[] Lookup(uint pid) {
    string[] cached;
    if (processes.TryGetValue(pid, out cached)) return cached;
    string exe = null, display = "";
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p != IntPtr.Zero) {
      try {
        var s = new StringBuilder(1024); int n = 1024;
        if (QueryFullProcessImageName(p, 0, s, ref n)) {
          string path = s.ToString(0, n);
          exe = Path.GetFileName(path);
          try {
            var info = FileVersionInfo.GetVersionInfo(path);
            display = !String.IsNullOrWhiteSpace(info.FileDescription) ? info.FileDescription : (info.ProductName ?? "");
          } catch {}
        }
      } finally { CloseHandle(p); }
    }
    cached = new string[] { exe, display.Trim() };
    if (processes.Count > 512) processes.Clear();
    processes[pid] = cached;
    return cached;
  }
  public static string ExeName(uint pid) { return Lookup(pid)[0]; }
  public static string DisplayName(uint pid) { return Lookup(pid)[1]; }
  public static long[] VisibleWindows() {
    var list = new List<long>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (list.Count >= 256) return false;
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
      if (Cloaked(h.ToInt64())) return true;
      list.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
  // Focused UI Automation element of the target process: [password state, control type].
  public static string[] Focus(uint pid) {
    if (uiaBusy) return new string[] { "unknown", "" };
    var result = new string[] { "unknown", "" };
    var done = new ManualResetEvent(false);
    uiaBusy = true;
    var worker = new Thread(delegate() {
      try {
        var element = AutomationElement.FocusedElement;
        if (element != null) {
          var current = element.Current;
          if (current.ProcessId == (int)pid) {
            result[0] = current.IsPassword ? "true" : "false";
            result[1] = current.ControlType != null ? current.ControlType.ProgrammaticName : "";
          }
        }
      } catch {} finally { uiaBusy = false; done.Set(); }
    });
    worker.IsBackground = true;
    worker.Start();
    if (!done.WaitOne(700)) return new string[] { "unknown", "" };
    return new string[] { result[0], result[1] };
  }
  public static Bitmap Capture(long handle) {
    IntPtr h = new IntPtr(handle);
    if (IsHungAppWindow(h) || IsIconic(h) || Affinity(handle) != 0 || Cloaked(handle)) return null;
    RECT r;
    if (!GetWindowRect(h, out r)) return null;
    int w = r.Right - r.Left, ht = r.Bottom - r.Top;
    if (w < 32 || ht < 32 || w > 8192 || ht > 8192) return null;
    var bmp = new Bitmap(w, ht, PixelFormat.Format32bppArgb);
    bool ok;
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr dc = g.GetHdc();
      try { ok = PrintWindow(h, dc, 2); } finally { g.ReleaseHdc(dc); }
    }
    if (!ok) { bmp.Dispose(); return null; }
    return bmp;
  }
  // Same nearest-neighbour 16x16 grid and weights as the macOS helper.
  public static string Fingerprint(Bitmap bmp) {
    var s = new StringBuilder(512);
    bool any = false;
    for (int y = 0; y < 16; y++) {
      int sy = Math.Min(bmp.Height - 1, (y * bmp.Height) / 16);
      for (int x = 0; x < 16; x++) {
        int sx = Math.Min(bmp.Width - 1, (x * bmp.Width) / 16);
        Color c = bmp.GetPixel(sx, sy);
        int gray = (77 * c.R + 150 * c.G + 29 * c.B) >> 8;
        if (gray != 0) any = true;
        s.Append(gray.ToString("x2"));
      }
    }
    // An all-black frame is a window that refused PrintWindow, not evidence.
    return any ? s.ToString() : null;
  }
  public static Bitmap Fit(Bitmap source, int max) {
    int longest = Math.Max(source.Width, source.Height);
    if (longest <= max) return new Bitmap(source);
    double scale = (double)max / longest;
    var scaled = new Bitmap(Math.Max(1, (int)(source.Width * scale)), Math.Max(1, (int)(source.Height * scale)), PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(scaled)) { g.DrawImage(source, 0, 0, scaled.Width, scaled.Height); }
    return scaled;
  }
}
`;

const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing,UIAutomationClient,UIAutomationTypes,WindowsBase -TypeDefinition $env:MOSS_HISTORY_HELPER_TYPE
[MossHistoryNative]::Init()
$testTargets = $env:MOSS_HISTORY_TEST_TARGETS -eq '1'
$maxText = [int]$env:MOSS_HISTORY_OCR_MAX_LENGTH
$frames = @{}
function Send($value) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 5)); [Console]::Out.Flush() }
$ocrEngine = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${"`"}1' })[0]
  $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $ocrEngine) { $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US')) }
} catch { $ocrEngine = $null }
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  if (-not $task.Wait(8000)) { throw 'timeout' }
  $task.Result
}
function Read-Text($bitmap) {
  $fitted = [MossHistoryNative]::Fit($bitmap, [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
  $memory = New-Object IO.MemoryStream
  try {
    $fitted.Save($memory, [Drawing.Imaging.ImageFormat]::Bmp)
    $memory.Position = 0
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($ocrEngine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
    $software.Dispose()
    $text = $result.Text
    if ($text -and $text.Length -gt $maxText) { $text = $text.Substring(0, $maxText) }
    return $text
  } finally { $memory.Dispose(); $fitted.Dispose() }
}
function Clear-Frames { foreach ($key in @($frames.Keys)) { $frames[$key].Dispose() }; $frames.Clear() }
function Probe($request) {
  # A test helper never looks at the real foreground window, only the window it was given.
  $explicit = $testTargets
  if ($testTargets) { $handle = 0; if ($request.hwnd) { $handle = [long]$request.hwnd } } else { $handle = [MossHistoryNative]::Foreground() }
  $target = $null
  if ($handle -ne 0) {
    $processId = [MossHistoryNative]::ProcessId($handle)
    $exe = [MossHistoryNative]::ExeName($processId)
    if ($exe) {
      $focus = [MossHistoryNative]::Focus($processId)
      $password = $null
      if ($focus[0] -eq 'true') { $password = $true } elseif ($focus[0] -eq 'false') { $password = $false }
      $control = $null
      if ($focus[1]) { $control = $focus[1] }
      $target = [ordered]@{ hwnd = $handle; processName = $exe; displayName = [MossHistoryNative]::DisplayName($processId); windowClass = [MossHistoryNative]::ClassName($handle); title = [MossHistoryNative]::Title($handle); cloaked = [MossHistoryNative]::Cloaked($handle); minimized = [MossHistoryNative]::Minimized($handle); displayAffinity = [MossHistoryNative]::Affinity($handle); passwordFocused = $password; focusedControl = $control }
    }
  }
  $others = New-Object Collections.ArrayList
  if (-not $explicit) {
    foreach ($window in [MossHistoryNative]::VisibleWindows()) {
      if ($window -eq $handle -or $others.Count -ge 64) { continue }
      $title = [MossHistoryNative]::Title($window)
      $exe = [MossHistoryNative]::ExeName([MossHistoryNative]::ProcessId($window))
      if ($exe -and $title) { [void]$others.Add([ordered]@{ processName = $exe; title = $title }) }
    }
  }
  $idle = [MossHistoryNative]::IdleSeconds()
  if ($idle -lt 0) { $idle = $null }
  return [ordered]@{ id = $request.id; type = 'probe'; capturedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); idleSeconds = $idle; target = $target; others = @($others) }
}
function Applications($request) {
  $shell = New-Object -ComObject WScript.Shell
  $seen = @{}
  $applications = New-Object Collections.ArrayList
  $iconCharacters = 0
  $roots = @([Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  foreach ($link in (Get-ChildItem -LiteralPath $roots -Recurse -Filter *.lnk -ErrorAction SilentlyContinue)) {
    if ($applications.Count -ge 500) { break }
    if ($link.BaseName -match '(?i)uninstall|readme|help|website|manual|\u5378\u8f7d|\u5e2e\u52a9|\u5b98\u7f51|\u8bf4\u660e') { continue }
    try { $targetPath = $shell.CreateShortcut($link.FullName).TargetPath } catch { continue }
    if (-not $targetPath -or -not $targetPath.ToLowerInvariant().EndsWith('.exe') -or -not (Test-Path -LiteralPath $targetPath)) { continue }
    $exe = [IO.Path]::GetFileName($targetPath)
    $key = $exe.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $icon = $null
    if ($iconCharacters -lt 4000000) {
      try {
        $source = [Drawing.Icon]::ExtractAssociatedIcon($targetPath)
        $image = $source.ToBitmap()
        $png = New-Object IO.MemoryStream
        $image.Save($png, [Drawing.Imaging.ImageFormat]::Png)
        $icon = 'data:image/png;base64,' + [Convert]::ToBase64String($png.ToArray())
        $iconCharacters += $icon.Length
        $png.Dispose(); $image.Dispose(); $source.Dispose()
      } catch { $icon = $null }
    }
    [void]$applications.Add([ordered]@{ processName = $exe; name = $link.BaseName; iconDataURL = $icon })
  }
  return [ordered]@{ id = $request.id; type = 'applications'; applications = @($applications) }
}
Send ([ordered]@{ type = 'ready'; ocr = ($null -ne $ocrEngine) })
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try { $request = ConvertFrom-Json -InputObject $line } catch { continue }
  try {
    switch ([string]$request.type) {
      'probe' { Send (Probe $request) }
      'capture' {
        Clear-Frames
        $handle = [long]$request.hwnd
        $fingerprint = $null
        $watch = [Diagnostics.Stopwatch]::StartNew()
        if ($testTargets -or [MossHistoryNative]::Foreground() -eq $handle) {
          $bitmap = [MossHistoryNative]::Capture($handle)
          if ($bitmap) {
            $fingerprint = [MossHistoryNative]::Fingerprint($bitmap)
            if ($fingerprint) { $frames[[string]$request.requestId] = $bitmap } else { $bitmap.Dispose() }
          }
        }
        Send ([ordered]@{ id = $request.id; type = 'capture'; fingerprint = $fingerprint; durationMs = $watch.ElapsedMilliseconds })
      }
      'ocr' {
        $key = [string]$request.requestId
        $bitmap = $frames[$key]
        $frames.Remove($key)
        $text = $null
        if ($bitmap) { try { if ($ocrEngine) { $text = Read-Text $bitmap } } finally { $bitmap.Dispose() } }
        Send ([ordered]@{ id = $request.id; type = 'ocr'; text = $text })
      }
      'drop' { Clear-Frames }
      'ocrFile' {
        $text = $null
        if ($testTargets -and $ocrEngine) { $bitmap = New-Object Drawing.Bitmap ([string]$request.path); try { $text = Read-Text $bitmap } finally { $bitmap.Dispose() } }
        Send ([ordered]@{ id = $request.id; type = 'ocr'; text = $text })
      }
      'applications' { Send (Applications $request) }
    }
  } catch { Send ([ordered]@{ id = $request.id; type = 'error' }) }
}
Clear-Frames
`;

export interface WindowsHistoryApplication {
  readonly processName: string;
  readonly name: string;
  readonly iconDataURL?: string;
}

/** Client for one running Windows helper process. Every call resolves; failures are null. */
export interface WindowsHistoryHelper {
  /** Resolves once the helper is up; `ocr` says whether Windows OCR is installed. */
  readonly ready: Promise<{ readonly ocr: boolean } | null>;
  /** `testHwnd` is honoured only by a helper started with `testTargets`. */
  readonly probe: (testHwnd?: number) => Promise<WindowsHistoryProbe | null>;
  readonly capture: (
    requestId: string,
    hwnd: number,
  ) => Promise<{ readonly fingerprint: Uint8Array; readonly durationMs: number } | null>;
  readonly ocr: (requestId: string) => Promise<string | null>;
  readonly drop: () => void;
  readonly applications: () => Promise<WindowsHistoryApplication[]>;
  readonly stop: () => Promise<void>;
}

export interface WindowsHistoryHelperOptions {
  /** Called once if the helper exits or stops answering while it was not being stopped. */
  readonly onExit: () => void;
  /** Test only: lets `probe`/`capture` target a synthetic window instead of the foreground. */
  readonly testTargets?: boolean;
}

const HELPER_LINE_MAX_CHARACTERS = 8 * 1024 * 1024;

export function startWindowsHistoryHelper(
  options: WindowsHistoryHelperOptions,
): WindowsHistoryHelper & {
  /** Test only: OCR an image file through the same Windows OCR path. */
  readonly ocrFile: (path: string) => Promise<string | null>;
} {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(HELPER_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        // The C# source travels in the environment: it is larger than a command line allows.
        MOSS_HISTORY_HELPER_TYPE: HELPER_CSHARP,
        MOSS_HISTORY_OCR_MAX_LENGTH: String(WINDOWS_HISTORY_OCR_MAX_LENGTH),
        ...(options.testTargets ? { MOSS_HISTORY_TEST_TARGETS: "1" } : {}),
      },
    },
  );
  guardChildStdio(child);
  let stopping = false;
  let exited = false;
  let nextId = 1;
  let pending = "";
  const waiters = new Map<number, (value: Record<string, unknown> | null) => void>();
  let resolveReady: (value: { readonly ocr: boolean } | null) => void = () => undefined;
  const ready = new Promise<{ readonly ocr: boolean } | null>((resolve) => {
    resolveReady = resolve;
  });
  const finish = () => {
    if (exited) return;
    exited = true;
    resolveReady(null);
    for (const waiter of waiters.values()) waiter(null);
    waiters.clear();
    if (!stopping) options.onExit();
  };
  child.on("error", finish);
  child.on("exit", finish);
  child.stdin.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    if (pending.length > HELPER_LINE_MAX_CHARACTERS) {
      pending = "";
      child.kill();
      return;
    }
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message.type === "ready") {
        resolveReady({ ocr: message.ocr === true });
        continue;
      }
      const id = typeof message.id === "number" ? message.id : -1;
      const waiter = waiters.get(id);
      if (!waiter) continue;
      waiters.delete(id);
      waiter(message.type === "error" ? null : message);
    }
  });
  const request = (
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> => {
    if (exited || stopping || child.stdin.destroyed) return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!waiters.delete(id)) return;
        resolve(null);
        // A helper that stops answering (for example on a hung target window) is replaced.
        child.kill();
      }, timeoutMs);
      timer.unref?.();
      waiters.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.stdin.write(`${JSON.stringify({ id, ...body })}\n`, () => undefined);
    });
  };
  const readText = (reply: Record<string, unknown> | null): string | null =>
    typeof reply?.text === "string" ? reply.text.slice(0, WINDOWS_HISTORY_OCR_MAX_LENGTH) : null;
  return {
    ready,
    probe: async (testHwnd) =>
      parseWindowsHistoryProbe(
        await request(
          { type: "probe", ...(testHwnd === undefined ? {} : { hwnd: testHwnd }) },
          8_000,
        ),
      ),
    capture: async (requestId, hwnd) => {
      const reply = await request({ type: "capture", requestId, hwnd }, 8_000);
      const fingerprint = parseWindowsHistoryFingerprint(reply?.fingerprint);
      if (!reply || !fingerprint) return null;
      const durationMs =
        typeof reply.durationMs === "number" && Number.isFinite(reply.durationMs)
          ? reply.durationMs
          : 0;
      return { fingerprint, durationMs };
    },
    ocr: async (requestId) => readText(await request({ type: "ocr", requestId }, 15_000)),
    ocrFile: async (path) => readText(await request({ type: "ocrFile", path }, 15_000)),
    drop: () => {
      if (!exited && !child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ id: 0, type: "drop" })}\n`, () => undefined);
      }
    },
    applications: async () => {
      const reply = await request({ type: "applications" }, 30_000);
      const applications = Array.isArray(reply?.applications) ? reply.applications : [];
      return applications.slice(0, 500).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        if (typeof item.processName !== "string" || typeof item.name !== "string") return [];
        return [
          {
            processName: item.processName,
            name: item.name,
            ...(typeof item.iconDataURL === "string" ? { iconDataURL: item.iconDataURL } : {}),
          },
        ];
      });
    },
    stop: async () => {
      stopping = true;
      if (exited || child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      // Closing stdin lets the helper dispose any frame and exit on its own.
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3_000);
      timer.unref?.();
      await closed;
      clearTimeout(timer);
    },
  };
}
