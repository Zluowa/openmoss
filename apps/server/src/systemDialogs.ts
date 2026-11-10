// FILE: systemDialogs.ts
// Purpose: Native OS dialogs the server raises on behalf of browser clients.
//          The folder picker runs a single fixed script per platform — macOS
//          osascript "choose folder", Windows PowerShell FolderBrowserDialog,
//          Linux zenity — with no user input ever interpolated into the command
//          line, so there is no injection surface. A cancelled picker resolves
//          to a null path; an unsupported platform, a missing binary, or a
//          helper that fails also sets `unavailable` so the web UI can offer a
//          typed path instead.
// Layer: Server system integration
// Exports: pickFolderNativeDialog, detectFolderPickerSupport, SystemCommandExecutor

import type { DialogsPickFolderResult } from "@moss/contracts";
import { execProcessFile } from "@moss/shared/processRuntime";

import { Effect } from "effect";

export interface SystemCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SystemCommandExecutor = (
  command: string,
  args: ReadonlyArray<string>,
  signal?: AbortSignal,
) => Promise<SystemCommandResult>;

/**
 * How long the Linux `zenity --version` availability probe may take before
 * zenity counts as missing. The interactive picker itself has no deadline: a
 * person may keep it open as long as they like, and it closes only when they
 * answer or the request is cancelled (the caller's AbortSignal).
 */
export const FOLDER_PICKER_PROBE_TIMEOUT_MS = 15_000;

const execFileExecutor =
  (deadline: { readonly timeoutMs?: number }): SystemCommandExecutor =>
  (command, args, signal) =>
    new Promise((resolve, reject) => {
      execProcessFile(
        command,
        [...args],
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          ...(deadline.timeoutMs !== undefined ? { timeout: deadline.timeoutMs } : {}),
          ...(signal ? { signal } : {}),
        },
        (error, stdout, stderr) => {
          const exitCode = (error as { code?: unknown } | null)?.code;
          // A numeric code means the process ran and exited non-zero (e.g. the user
          // cancelled the dialog); anything else is a spawn failure (ENOENT…).
          if (error && typeof exitCode !== "number") {
            reject(error);
            return;
          }
          resolve({ code: typeof exitCode === "number" ? exitCode : 0, stdout, stderr });
        },
      );
    });

const runFolderPicker = execFileExecutor({});
const runFolderPickerProbe = execFileExecutor({ timeoutMs: FOLDER_PICKER_PROBE_TIMEOUT_MS });

interface FolderPickerCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

// Fixed scripts only — never concatenate request data into these.
const MACOS_FOLDER_PICKER: FolderPickerCommand = {
  // "choose folder" exits 1 on cancel; the mapping to null happens below.
  command: "osascript",
  args: ["-e", "POSIX path of (choose folder)"],
};

const WINDOWS_FOLDER_PICKER: FolderPickerCommand = {
  command: "powershell",
  args: [
    "-STA",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); " +
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; " +
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) " +
      "{ [Console]::Out.Write($dialog.SelectedPath) }",
  ],
};

const LINUX_FOLDER_PICKER: FolderPickerCommand = {
  command: "zenity",
  args: ["--file-selection", "--directory"],
};

export function resolveFolderPickerCommand(platform: NodeJS.Platform): FolderPickerCommand | null {
  switch (platform) {
    case "darwin":
      return MACOS_FOLDER_PICKER;
    case "win32":
      return WINDOWS_FOLDER_PICKER;
    case "linux":
      return LINUX_FOLDER_PICKER;
    default:
      return null;
  }
}

function normalizePickedPath(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  // osascript's POSIX path ends folders with a trailing slash; strip it so the
  // result matches Electron's dialog.showOpenDialog shape (a root "/" keeps it).
  const withoutTrailing = trimmed.replace(/[/\\]+$/, "");
  return withoutTrailing.length > 0 ? withoutTrailing : trimmed;
}

/**
 * Whether a non-zero exit is the person dismissing the picker rather than the
 * helper failing. osascript reports a cancel as AppleScript error -128 and
 * zenity exits 1; the Windows script exits 0 with no output on cancel, so any
 * non-zero exit there is a failure.
 */
function isFolderPickerCancelExit(platform: NodeJS.Platform, result: SystemCommandResult) {
  switch (platform) {
    case "darwin":
      return result.code === 1 && (result.stderr.trim() === "" || result.stderr.includes("-128"));
    case "linux":
      return result.code === 1;
    default:
      return false;
  }
}

const FOLDER_PICKER_UNAVAILABLE: DialogsPickFolderResult = { path: null, unavailable: true };

export function pickFolderNativeDialog(options?: {
  readonly platform?: NodeJS.Platform;
  readonly executor?: SystemCommandExecutor;
}): Effect.Effect<DialogsPickFolderResult> {
  const platform = options?.platform ?? process.platform;
  return Effect.promise(async (signal) => {
    const executor =
      options?.executor ?? ((command, args) => runFolderPicker(command, args, signal));
    const picker = resolveFolderPickerCommand(platform);
    if (!picker) return FOLDER_PICKER_UNAVAILABLE;
    try {
      const result = await executor(picker.command, picker.args);
      if (result.code !== 0) {
        return isFolderPickerCancelExit(platform, result)
          ? { path: null }
          : FOLDER_PICKER_UNAVAILABLE;
      }
      // Exit 0 with no output is a dismissed picker on Windows.
      return { path: normalizePickedPath(result.stdout) };
    } catch {
      // Picker binary missing (e.g. no zenity on a headless Linux box) or the
      // helper could not start.
      return FOLDER_PICKER_UNAVAILABLE;
    }
  });
}

/**
 * Whether `dialogs.pickFolder` can work on this host. osascript and PowerShell
 * ship with their OSes; Linux depends on zenity being installed, probed once
 * at server startup. Anything unknown reports unsupported so the web UI shows
 * its typed-path fallback.
 */
export function detectFolderPickerSupport(options?: {
  readonly platform?: NodeJS.Platform;
  readonly executor?: SystemCommandExecutor;
}): Effect.Effect<boolean> {
  const platform = options?.platform ?? process.platform;
  const executor = options?.executor ?? runFolderPickerProbe;
  return Effect.promise(async () => {
    switch (platform) {
      case "darwin":
      case "win32":
        return true;
      case "linux":
        try {
          await executor("zenity", ["--version"]);
          return true;
        } catch {
          return false;
        }
      default:
        return false;
    }
  });
}
