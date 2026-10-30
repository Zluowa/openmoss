// FILE: systemDialogs.ts
// Purpose: Native OS dialogs the server raises on behalf of browser clients.
//          The folder picker runs a single fixed script per platform — macOS
//          osascript "choose folder", Windows PowerShell FolderBrowserDialog,
//          Linux zenity — with no user input ever interpolated into the command
//          line, so there is no injection surface. Cancellation, unsupported
//          platforms, and missing binaries all resolve to null so the web UI
//          can fall back to a typed path.
// Layer: Server system integration
// Exports: pickFolderNativeDialog, detectFolderPickerSupport, SystemCommandExecutor

import { execFile } from "node:child_process";

import { Effect } from "effect";

export interface SystemCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SystemCommandExecutor = (
  command: string,
  args: ReadonlyArray<string>,
) => Promise<SystemCommandResult>;

const execFileExecutor: SystemCommandExecutor = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = (error as { code?: unknown } | null)?.code;
      // A numeric code means the process ran and exited non-zero (e.g. the user
      // cancelled the dialog); anything else is a spawn failure (ENOENT…).
      if (error && typeof exitCode !== "number") {
        reject(error);
        return;
      }
      resolve({ code: typeof exitCode === "number" ? exitCode : 0, stdout, stderr });
    });
  });

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
    "-NoProfile",
    "-NonInteractive",
    "-Command",
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

export function pickFolderNativeDialog(options?: {
  readonly platform?: NodeJS.Platform;
  readonly executor?: SystemCommandExecutor;
}): Effect.Effect<{ readonly path: string | null }> {
  const platform = options?.platform ?? process.platform;
  const executor = options?.executor ?? execFileExecutor;
  return Effect.promise(async () => {
    const picker = resolveFolderPickerCommand(platform);
    if (!picker) return { path: null };
    try {
      const result = await executor(picker.command, picker.args);
      // Any non-zero exit (cancel on macOS/zenity, dialog dismissed elsewhere)
      // degrades to null rather than an RPC error.
      if (result.code !== 0) return { path: null };
      return { path: normalizePickedPath(result.stdout) };
    } catch {
      // Picker binary missing (e.g. no zenity on a headless Linux box).
      return { path: null };
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
  const executor = options?.executor ?? execFileExecutor;
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
