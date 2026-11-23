// FILE: shellCommandShape.ts
// Purpose: What a shell command a tool row shows is, read the same way on the desktop and the
//          phone: shell wrappers and preambles peeled off, file reads recognised, and the
//          command's kind (read, search, git, GitHub, plain terminal) for the row's icon.
// Layer: Shared pure logic (no DOM, no React, no other package imports), so the phone app
//          can import it through Metro.
// Exports: resolveCommandVisualKind, deriveCommandReadTargets, unwrapWindowsShellCommand and
//          the parsing helpers the desktop's command labels build on.
// Moved unchanged from apps/web/src/lib/toolCallLabel.ts (2026-11-24) so the phone stops
// keeping a second classifier for the same rows.

export type CommandVisualKind = "read" | "search" | "git" | "github" | "terminal";

export type CommandShellDialect = "posix" | "powershell" | "cmd";

/** The last path segment, for either slash. */
function commandBasename(pathValue: string): string {
  const slashIndex = Math.max(pathValue.lastIndexOf("/"), pathValue.lastIndexOf("\\"));
  return slashIndex === -1 ? pathValue : pathValue.slice(slashIndex + 1);
}

// Read-only inspection commands: file reads wear the file glyph, searches and
// finds the magnifier; listings and everything else keep the terminal icon.
// These sets are the single source of truth for both the command labels below
// and the icon decision.
// Readers per shell. `type` reads a file only under cmd and PowerShell (on POSIX
// shells it says what a command is); PowerShell's `cat` and `gc` are aliases of
// Get-Content.
export const POSIX_READ_FILE_COMMAND_TOOLS = new Set([
  "cat",
  "nl",
  "head",
  "tail",
  "sed",
  "less",
  "more",
]);

export const POWERSHELL_READ_FILE_COMMAND_TOOLS = new Set(["get-content", "gc", "cat", "type"]);

export const CMD_READ_FILE_COMMAND_TOOLS = new Set(["type"]);

// Get-Content parameters a plain read may carry. Any other parameter (common
// parameters such as -ErrorAction or -OutVariable, -Filter, -Include, an
// abbreviation) makes the command unprovable as a read.
export const GET_CONTENT_SWITCHES = new Set(["-raw", "-force", "-wait", "-asbytestream"]);

export const GET_CONTENT_VALUE_OPTIONS = new Set([
  "-totalcount",
  "-head",
  "-first",
  "-tail",
  "-last",
  "-encoding",
  "-delimiter",
  "-readcount",
  "-stream",
]);

export const GET_CONTENT_PATH_OPTIONS = new Set(["-path", "-literalpath", "-lp", "-pspath"]);

export const SEARCH_COMMAND_TOOLS = new Set(["rg", "grep", "ag", "ack"]);

export const FIND_COMMAND_TOOLS = new Set(["find", "fd"]);

export function firstCommandExecutable(rawCommand: string): string {
  const trimmed = rawCommand.trim();
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(trimmed);
  const executable = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return executable.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
}

// Classifies command rows for transcript glyphs after peeling away shell/env wrappers.
// This keeps `git -C`, `env ... gh`, and `/bin/zsh -lc "cd ... && git ..."` visually branded.
export function resolveCommandVisualKind(rawCommand: string): CommandVisualKind {
  if (deriveCommandReadTargets(rawCommand) !== null) {
    return "read";
  }
  const command = stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
  const [tool] = splitToolAndArgs(firstShellCommandSegment(command));
  // A search followed by anything else is not "a search".
  if (
    (SEARCH_COMMAND_TOOLS.has(tool) || FIND_COMMAND_TOOLS.has(tool)) &&
    !hasCommandSeparator(deriveCommandScript(rawCommand), commandShellDialect(rawCommand))
  ) {
    return "search";
  }
  if (tool === "git") {
    return "git";
  }
  if (tool === "gh" || tool === "hub") {
    return "github";
  }
  return "terminal";
}

// The unwrapped command with its line breaks kept: line breaks separate
// commands, so every "is this one read?" check runs on this text.
export function deriveCommandScript(rawCommand: string): string {
  let value = unwrapWindowsShellCommand(rawCommand) ?? rawCommand.trim();
  const lowered = value.toLowerCase();
  for (const prefix of SHELL_WRAPPER_PREFIXES) {
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    value = value.slice(prefix.length).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    break;
  }
  return stripLeadingShellPreambles(value).trim();
}

// Which shell parses the command: the Windows launcher when there is one, a bare
// PowerShell cmdlet, else a POSIX shell.
export function commandShellDialect(rawCommand: string): CommandShellDialect {
  const executable = firstCommandExecutable(rawCommand).replace(/\.exe$/u, "");
  if (unwrapWindowsShellCommand(rawCommand) !== null) {
    return executable === "cmd" ? "cmd" : "powershell";
  }
  return executable === "get-content" || executable === "gc" ? "powershell" : "posix";
}

// Anything that could make a command do more than its first word says: chains,
// pipes, redirects, line breaks, substitutions and, for PowerShell, grouping and
// script blocks. Quoting follows the dialect (PowerShell has no `\` escape, and
// expands `$(…)` inside double quotes).
export function hasCommandSeparator(script: string, dialect: CommandShellDialect): boolean {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    const next = script[index + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (dialect === "posix" && char === "\\") {
        index += 1;
        continue;
      }
      if (dialect === "powershell" && char === "`") {
        index += 1;
        continue;
      }
      if (char === '"') {
        quote = null;
        continue;
      }
      if (dialect !== "cmd" && char === "$" && (next === "(" || next === "{")) return true;
      if (dialect === "posix" && char === "`") return true;
      continue;
    }
    if (dialect === "posix" && char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"' || (char === "'" && dialect !== "cmd")) {
      quote = char;
      continue;
    }
    if (
      char === "\n" ||
      char === "\r" ||
      char === "|" ||
      char === "&" ||
      char === ";" ||
      char === ">" ||
      char === "<" ||
      char === "`"
    ) {
      return true;
    }
    if (dialect === "posix" && char === "$" && next === "(") return true;
    if (dialect === "powershell" && (char === "(" || char === "{" || char === ",")) return true;
    if (dialect === "cmd" && (char === "(" || char === "^")) return true;
  }
  return false;
}

// Arguments as the dialect reads them; PowerShell and cmd keep backslashes.
export function tokenizeDialectArgs(args: string, dialect: CommandShellDialect): string[] {
  if (dialect === "posix") return tokenizeCommandArgs(args);
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const match of args.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

// Files a command only reads, or null when the command does anything else.
// A row may say "Read <file>" instead of the literal command only when that
// is the whole story: one command, no pipes, chains, redirects, line breaks or
// substitutions, only options the parser knows, and no in-place edit (`sed -i`).
export function deriveCommandReadTargets(rawCommand: string): string[] | null {
  const script = deriveCommandScript(rawCommand);
  const dialect = commandShellDialect(rawCommand);
  if (script.length === 0 || hasCommandSeparator(script, dialect)) {
    return null;
  }
  const literal = script.replace(/\s+/g, " ").trim();
  const [tool, args] = splitToolAndArgs(
    dialect === "posix" ? stripCommandDisplayWrappers(literal) : literal,
  );
  const readers =
    dialect === "powershell"
      ? POWERSHELL_READ_FILE_COMMAND_TOOLS
      : dialect === "cmd"
        ? CMD_READ_FILE_COMMAND_TOOLS
        : POSIX_READ_FILE_COMMAND_TOOLS;
  if (!readers.has(tool)) {
    return null;
  }
  const tokens = tokenizeDialectArgs(args, dialect);
  if (dialect !== "posix") {
    return readWindowsReadTargets(tokens, dialect);
  }
  const files: string[] = [];
  let skipNext = false;
  let sedScriptPending = tool === "sed";
  let sedPrintOnly = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (tool === "sed") {
        if (token === "-i" || token.startsWith("-i") || token.startsWith("--in-place")) {
          return null;
        }
        if (token === "-n" || token === "--quiet" || token === "--silent") {
          sedPrintOnly = true;
        }
        if (token === "-e" || token === "--expression") {
          sedScriptPending = false;
          skipNext = true;
        }
      }
      if ((tool === "head" || tool === "tail") && (token === "-n" || token === "-c")) {
        skipNext = true;
      }
      continue;
    }
    if (sedScriptPending) {
      sedScriptPending = false;
      continue;
    }
    files.push(compactPath(token));
  }
  if (tool === "sed" && !sedPrintOnly) {
    return null;
  }
  return files.length > 0 ? files : null;
}

// Get-Content (and PowerShell's / cmd's `type`) with known parameters only;
// a variable or wildcard target is not a file the row can name.
export function readWindowsReadTargets(
  tokens: ReadonlyArray<string>,
  dialect: Exclude<CommandShellDialect, "posix">,
): string[] | null {
  const files: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const option = token.toLowerCase();
    if (dialect === "powershell" && token.startsWith("-") && token.length > 1) {
      if (GET_CONTENT_SWITCHES.has(option)) continue;
      if (GET_CONTENT_VALUE_OPTIONS.has(option)) {
        if (tokens[index + 1] === undefined) return null;
        index += 1;
        continue;
      }
      if (GET_CONTENT_PATH_OPTIONS.has(option)) {
        const path = tokens[index + 1];
        if (path === undefined || !isPlainFileArgument(path)) return null;
        files.push(compactPath(path));
        index += 1;
        continue;
      }
      return null;
    }
    if (dialect === "cmd" && token.startsWith("/")) return null;
    if (!isPlainFileArgument(token)) return null;
    files.push(compactPath(token));
  }
  return files.length > 0 ? files : null;
}

export function isPlainFileArgument(token: string): boolean {
  return token.length > 0 && !/[$*?%@[\]]/u.test(token);
}

// Codex on Windows launches every command through PowerShell (or cmd) and
// reports the launcher line, quoted the POSIX way:
//   "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw 'a.md'"
// Returns the command the shell ran (`Get-Content -Raw 'a.md'`), or null when
// the line is not such a wrapper, or when the launcher carries anything that
// changes what runs (an execution policy, a working directory, `cmd /k`): then
// the row shows the whole line. Whitespace inside the command is kept.
export function unwrapWindowsShellCommand(rawCommand: string): string | null {
  const trimmed = rawCommand.trim();
  const executable = firstCommandExecutable(trimmed).replace(/\.exe$/u, "");
  const isPowerShell = executable === "powershell" || executable === "pwsh";
  if (!isPowerShell && executable !== "cmd") {
    return null;
  }
  const argv = splitPosixQuotedArgv(trimmed);
  if (!argv || argv.length < 2) {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index]!.toLowerCase();
    if (isPowerShell) {
      if (option === "-command" || option === "-c" || option === "/command" || option === "/c") {
        const command = argv
          .slice(index + 1)
          .join(" ")
          .trim();
        return command.length > 0 ? command : null;
      }
      if (POWERSHELL_SWITCH_OPTIONS.has(option)) {
        continue;
      }
      return null;
    }
    if (option === "/c") {
      const command = argv
        .slice(index + 1)
        .join(" ")
        .trim();
      return command.length > 0 ? command : null;
    }
    if (CMD_SWITCH_OPTIONS.has(option)) {
      continue;
    }
    return null;
  }
  return null;
}

// Launcher switches Codex and Moss pass that do not change what the command does.
export const POWERSHELL_SWITCH_OPTIONS = new Set([
  "-noprofile",
  "-nop",
  "-nologo",
  "-noninteractive",
  "-noni",
]);

export const CMD_SWITCH_OPTIONS = new Set(["/d", "/s", "/q"]);

// Splits a launcher line into argv with POSIX shell quoting: '…' is literal,
// "…" honours \\, \", \$ and \` escapes, and adjacent pieces join into one
// argument (`'a'"'"'b'` is `a'b`). Null when a quote never closes, or when a
// backslash stands outside quotes: that is a bare Windows path, not the quoted
// form this splitter reads, so the line is left as it is.
export function splitPosixQuotedArgv(value: string): string[] | null {
  const argv: string[] = [];
  let current = "";
  let inToken = false;
  let index = 0;
  while (index < value.length) {
    const char = value[index]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (inToken) {
        argv.push(current);
        current = "";
        inToken = false;
      }
      index += 1;
      continue;
    }
    inToken = true;
    if (char === "'") {
      const end = value.indexOf("'", index + 1);
      if (end === -1) return null;
      current += value.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const inner = value[index]!;
        if (inner === "\\" && index + 1 < value.length) {
          const next = value[index + 1]!;
          if (next === "\\" || next === '"' || next === "$" || next === "`") {
            current += next;
            index += 2;
            continue;
          }
          if (next === "\n") {
            index += 2;
            continue;
          }
        }
        if (inner === '"') {
          closed = true;
          index += 1;
          break;
        }
        current += inner;
        index += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (char === "\\") {
      return null;
    }
    current += char;
    index += 1;
  }
  if (inToken) argv.push(current);
  return argv;
}

export const SHELL_WRAPPER_PREFIXES = [
  "/usr/bin/bash -lc ",
  "/usr/bin/bash -c ",
  "/bin/bash -lc ",
  "/bin/bash -c ",
  "/usr/bin/zsh -lc ",
  "/usr/bin/zsh -c ",
  "/bin/zsh -lc ",
  "/bin/zsh -c ",
  "/bin/sh -lc ",
  "/bin/sh -c ",
  "bash -lc ",
  "bash -c ",
  "zsh -lc ",
  "zsh -c ",
  "sh -lc ",
  "sh -c ",
];

export function compactPath(path: string, locale: string = "en"): string {
  if (path === ".") {
    return locale === "zh-CN" ? "当前目录" : "current directory";
  }
  if (path === "..") {
    return locale === "zh-CN" ? "上级目录" : "parent directory";
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    return path;
  }
  return parts.slice(-2).join("/");
}

export function firstShellCommandSegment(command: string): string {
  const chain = findShellChain(command);
  return chain ? command.slice(0, chain.operatorStart).trim() : command;
}

export function tokenizeCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < args.length) {
    while (args[index] === " ") {
      index += 1;
    }
    if (index >= args.length) {
      break;
    }

    const quote = args[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let token = "";
      while (index < args.length && args[index] !== quote) {
        if (args[index] === "\\" && index + 1 < args.length) {
          token += args[index + 1];
          index += 2;
          continue;
        }
        token += args[index];
        index += 1;
      }
      if (args[index] === quote) {
        index += 1;
      }
      tokens.push(token);
      continue;
    }

    let token = "";
    while (index < args.length && args[index] !== " ") {
      token += args[index];
      index += 1;
    }
    if (token) {
      tokens.push(token);
    }
  }

  return tokens;
}

export function splitToolAndArgs(command: string): [tool: string, args: string] {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return ["", ""];
  }
  const separator = normalized.indexOf(" ");
  if (separator === -1) {
    return [commandBasename(normalized).toLowerCase(), ""];
  }
  const tool = commandBasename(normalized.slice(0, separator)).toLowerCase();
  const args = normalized.slice(separator + 1).trim();
  return [tool, args];
}

export function unwrapShellCommandIfPresent(rawCommand: string): string {
  let value = unwrapWindowsShellCommand(rawCommand) ?? rawCommand.trim();
  if (!value) {
    return value;
  }

  const lowered = value.toLowerCase();
  for (const prefix of SHELL_WRAPPER_PREFIXES) {
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    value = value.slice(prefix.length).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    break;
  }
  // Setup lines (`cd`, env and proxy variables) never name what ran.
  value = stripLeadingShellPreambles(value);

  const pipeIndex = value.indexOf("|");
  if (pipeIndex > 0) {
    value = value.slice(0, pipeIndex).trim();
  }

  return value;
}

export function stripLeadingShellPreambles(value: string): string {
  let current = value.trim();
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const chain = findShellChain(current);
    if (!chain) {
      return current;
    }
    const head = current.slice(0, chain.operatorStart).trim();
    if (!isShellSetupPreamble(head)) {
      return current;
    }
    current = current.slice(chain.commandStart).trim();
  }
  return current;
}

export function isShellSetupPreamble(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (/^(?:builtin\s+)?cd\s+/.test(normalized)) {
    return true;
  }
  if (/^(?:source|\.)\s+/.test(normalized)) {
    return true;
  }
  if (/^set\s+[-+][A-Za-z]/.test(normalized)) {
    return true;
  }
  if (
    /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=[^\s]+(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]+)*$/.test(
      normalized,
    )
  ) {
    return true;
  }
  return isWindowsShellSetupPreamble(normalized);
}

// The Windows lines an agent puts before the real command: environment and
// proxy variables, the working folder, error and output settings
// (`$env:NO_PROXY='…'; Remove-Item Env:HTTP_PROXY; & bun …`, `set X=1 && …`).
export function isWindowsShellSetupPreamble(normalized: string): boolean {
  return (
    /^\$env:[A-Za-z_][\w]*\s*=/iu.test(normalized) ||
    /^(?:remove-item|ri|del|set-item|si)\s+(?:-path\s+|-literalpath\s+)?env:/iu.test(normalized) ||
    /^(?:set-location|push-location|sl|pushd|chdir)\s+/iu.test(normalized) ||
    /^\$(?:ErrorActionPreference|ProgressPreference|OutputEncoding|PSNativeCommandUseErrorActionPreference)\s*=/iu.test(
      normalized,
    ) ||
    /^\[(?:System\.)?Console\]::(?:Output|Input)Encoding\s*=/iu.test(normalized) ||
    /^(?:chcp\s+\d+|set\s+"?[A-Za-z_][\w]*=)/iu.test(normalized)
  );
}

export function findShellChain(
  value: string,
): { operatorStart: number; commandStart: number } | null {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const next = value[index + 1];
    if (char === "&" && next === "&") {
      return { operatorStart: index, commandStart: index + 2 };
    }
    if (char === ";") {
      return { operatorStart: index, commandStart: index + 1 };
    }
  }

  return null;
}

export function stripCommandDisplayWrappers(command: string): string {
  let current = command.replace(/\s+/g, " ").trim();
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const [tool, args] = splitToolAndArgs(current);
    const next =
      tool === "env"
        ? stripEnvCommand(args)
        : tool === "timeout" || tool === "gtimeout"
          ? stripTimeoutCommand(args)
          : tool === "nice"
            ? stripNiceCommand(args)
            : tool === "arch"
              ? stripArchCommand(args)
              : tool === "command"
                ? args
                : null;
    if (!next || next === current) {
      return current;
    }
    current = next.trim();
  }
  return current;
}

export function stripEnvCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
      index += 2;
      continue;
    }
    if (token.startsWith("--unset=") || token.startsWith("--chdir=")) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

export function stripTimeoutCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length && tokens[index]?.startsWith("-")) {
    index += tokens[index] === "-s" || tokens[index] === "-k" ? 2 : 1;
  }
  if (index < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[index]!)) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

export function stripNiceCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  if (tokens[index] === "-n") {
    index += 2;
  } else {
    while (tokens[index]?.startsWith("-")) {
      index += 1;
    }
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

export function stripArchCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (tokens[index]?.startsWith("-")) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}
