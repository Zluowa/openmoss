// FILE: launchRunFailure.ts
// Purpose: Why a project's server did not start, in terms a person can act on: the program
//   it needs is not installed, its port is taken, or it stopped by itself. Shared by the
//   server (which checks the program before starting) and the web (which reads what a run
//   printed before it stopped).
// Layer: Shared runtime utility (pure)

/** The program a command line starts with: `python` in `python -m http.server 8123`. */
export function commandProgram(commandLine: string): string | null {
  // PowerShell runs a quoted program through `&`.
  const trimmed = commandLine.trim().replace(/^&\s+/, "");
  if (!trimmed) return null;
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    const value = (end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)).trim();
    return value || null;
  }
  const first = trimmed.split(/\s+/, 1)[0] ?? "";
  // `KEY=value cmd` (a POSIX environment prefix) runs `cmd`.
  if (/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(first)) {
    return commandProgram(trimmed.slice(first.length));
  }
  return first || null;
}

/** A program's file name without its folder or Windows extension, lowercased. */
export function programBaseName(program: string): string {
  const base = program.split(/[\\/]/).pop() ?? program;
  return base.replace(/\.(?:exe|cmd|bat|com|ps1)$/i, "").toLowerCase();
}

const PRODUCT_BY_PROGRAM: Readonly<Record<string, string>> = {
  python: "Python",
  python3: "Python",
  py: "Python",
  pip: "Python",
  pip3: "Python",
  uv: "uv",
  uvx: "uv",
  node: "Node.js",
  npm: "Node.js",
  npx: "Node.js",
  corepack: "Node.js",
  pnpm: "pnpm",
  pnpx: "pnpm",
  yarn: "Yarn",
  bun: "Bun",
  bunx: "Bun",
  deno: "Deno",
  php: "PHP",
  ruby: "Ruby",
  bundle: "Ruby",
  rails: "Ruby on Rails",
  go: "Go",
  java: "Java",
  mvn: "Maven",
  gradle: "Gradle",
  dotnet: ".NET",
  cargo: "Rust",
  docker: "Docker",
  hugo: "Hugo",
  jekyll: "Jekyll",
};

/** The product to install for a missing program (`npx` comes with Node.js), when known. */
export function launchProgramProduct(program: string): string | null {
  return PRODUCT_BY_PROGRAM[programBaseName(program)] ?? null;
}

export type LaunchRunFailure =
  | { readonly kind: "program-missing"; readonly program: string }
  | { readonly kind: "port-in-use"; readonly port: number | null }
  | { readonly kind: "stopped" };

// What shells print when a program is not installed, with the program's name captured.
const PROGRAM_MISSING_PATTERNS: readonly RegExp[] = [
  // PowerShell: "python : The term 'python' is not recognized as the name of a cmdlet"
  /The term '([^']+)' is not recognized/i,
  // PowerShell (Chinese): "无法将“python”项识别为 cmdlet、函数、脚本文件或可运行程序的名称"
  /无法将[“"']([^”"']+)[”"']项识别为/,
  // cmd.exe: "'python' is not recognized as an internal or external command"
  /'([^']+)' is not recognized as an internal or external command/i,
  // cmd.exe (Chinese): "'python' 不是内部或外部命令"
  /'([^']+)'\s*不是内部或外部命令/,
  // zsh: "zsh: command not found: python"
  /command not found: (\S+)/i,
  // bash/sh: "bash: python: command not found", "sh: 1: python: not found"
  /(?:^|\n)[\w./-]*sh(?::\s*\d+)?:\s*([^\s:]+):\s*(?:command )?not found/i,
];

// Windows' Store shortcut stands in for a Python that is not installed.
const WINDOWS_STORE_PYTHON_PATTERN = /Python was not found; run without arguments to install/i;
const POWERSHELL_COMMAND_NOT_FOUND_PATTERN = /CommandNotFoundException/i;
const PORT_IN_USE_PATTERN =
  /EADDRINUSE|address already in use|Only one usage of each socket address|只允许使用一次|端口.{0,12}被占用|(?:Errno|WinError) (?:98|48|10048)\b/i;
const PRINTED_PORT_PATTERN = /(?::|port\s+)(\d{2,5})\b/i;

/**
 * Why a launch run ended before it answered, from what it printed (`output`) and the
 * program its command starts with (`program`, used when the shell names no program).
 */
export function classifyLaunchRunFailure(input: {
  readonly output: string | null;
  readonly program?: string | null;
  readonly port?: number | null;
}): LaunchRunFailure {
  const output = input.output ?? "";
  for (const pattern of PROGRAM_MISSING_PATTERNS) {
    const match = pattern.exec(output);
    const program = match?.[1]?.trim();
    if (program) return { kind: "program-missing", program };
  }
  if (WINDOWS_STORE_PYTHON_PATTERN.test(output)) {
    return { kind: "program-missing", program: input.program ?? "python" };
  }
  if (POWERSHELL_COMMAND_NOT_FOUND_PATTERN.test(output) && input.program) {
    return { kind: "program-missing", program: input.program };
  }
  const portLine = output.split(/\r?\n/).find((line) => PORT_IN_USE_PATTERN.test(line));
  if (portLine !== undefined) {
    const printed = PRINTED_PORT_PATTERN.exec(portLine)?.[1];
    const port = printed ? Number(printed) : (input.port ?? null);
    return { kind: "port-in-use", port: port !== null && port > 0 && port <= 65_535 ? port : null };
  }
  return { kind: "stopped" };
}
