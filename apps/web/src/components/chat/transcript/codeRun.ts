// FILE: codeRun.ts
// Purpose: The desktop chat's "Run in terminal" on shell code blocks: which fences are
//          runnable, how a block becomes one command line per line (prompt marks and
//          comments dropped), and the context a chat provides to run it.
// Layer: Chat transcript behavior
// Exports: CodeRunContext, isRunnableShellFence, prepareShellCommand

import { createContext } from "react";

export interface CodeRunActions {
  /** Types the command into this chat's terminal and runs it. */
  runInTerminal: (command: string) => void;
  /** "powershell" labels the action "Run in PowerShell", as the desktop chat does on Windows. */
  shell: "posix" | "powershell";
}

export const CodeRunContext = createContext<CodeRunActions | null>(null);

const SHELL_LANGUAGES = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
  "shellsession",
  "powershell",
  "pwsh",
  "ps1",
  "ps",
  "cmd",
  "bat",
]);

export function isRunnableShellFence(language: string): boolean {
  return SHELL_LANGUAGES.has(language.trim().toLowerCase());
}

/** Lines to run: drops prompt marks ("$ ", "> ", "PS> ") and comment-only lines. */
export function prepareShellCommand(code: string): string {
  return code
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:PS[^>]*>|\$|>)\s+/, ""))
    .filter((line) => line.trim() !== "" && !/^\s*(?:#|REM\b|::)/i.test(line))
    .join("\n")
    .trim();
}
