// Command rows for Codex on Windows: Codex launches every command through
// PowerShell (or cmd) and persists the launcher line, quoted the POSIX way.
// The lines below are copied from the owner's 2026-11-17 chat
// (round 20261117-owner-test); the user name is redacted.

import { describe, expect, it } from "vitest";

import { normalizeShellCommand } from "../components/chat/CommandShellDetails.logic";
import {
  deriveCommandReadTargets,
  deriveLiteralCommand,
  deriveReadableCommandDisplay,
  resolveCommandVisualKind,
  unwrapWindowsShellCommand,
} from "./toolCallLabel";

// `"C:\\WINDOWS\\...\\powershell.exe"` with the doubled backslashes Codex stores.
const POWERSHELL_EXE = '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe"';

describe("unwrapWindowsShellCommand", () => {
  it("returns the command PowerShell ran, not the launcher", () => {
    expect(
      unwrapWindowsShellCommand(
        `${POWERSHELL_EXE} -Command "Get-Content -Raw 'E:/Codex/home/skills/.system/imagegen/SKILL.md'"`,
      ),
    ).toBe("Get-Content -Raw 'E:/Codex/home/skills/.system/imagegen/SKILL.md'");
  });

  it("joins POSIX-quoted pieces and keeps the command's own quotes", () => {
    expect(
      unwrapWindowsShellCommand(
        `${POWERSHELL_EXE} -Command '$p='"'"'outputs/a.png'"'"'; python -c "print(1)"'`,
      ),
    ).toBe(`$p='outputs/a.png'; python -c "print(1)"`);
    expect(
      unwrapWindowsShellCommand(
        `${POWERSHELL_EXE} -Command "python -c \\"from PIL import Image\\""`,
      ),
    ).toBe('python -c "from PIL import Image"');
  });

  it("keeps a multi-line script intact", () => {
    expect(
      unwrapWindowsShellCommand(`${POWERSHELL_EXE} -Command "python - <<'PY'\nprint(1)\nPY"`),
    ).toBe("python - <<'PY'\nprint(1)\nPY");
  });

  it("skips only the launcher switches that do not change what runs", () => {
    expect(unwrapWindowsShellCommand("pwsh -NoProfile -NonInteractive -NoLogo -Command 'ls'")).toBe(
      "ls",
    );
    expect(unwrapWindowsShellCommand('cmd.exe /d /s /c "dir /b"')).toBe("dir /b");
  });

  // Review item 4: a launcher option that changes what runs must stay visible.
  it("keeps the whole line when the launcher carries options that matter", () => {
    const line =
      'powershell -ExecutionPolicy Bypass -WorkingDirectory D:/tmp -Command "Remove-Item a"';
    expect(unwrapWindowsShellCommand(line)).toBeNull();
    expect(deriveLiteralCommand(line)).toBe(line);
    expect(normalizeShellCommand(line)).toBe(line);
    expect(unwrapWindowsShellCommand("pwsh -ExecutionPolicy Bypass -Command 'ls'")).toBeNull();
    expect(unwrapWindowsShellCommand('cmd.exe /k "dir"')).toBeNull();
  });

  // Review item 5: the splitter is for Codex's POSIX-quoted lines; a line with
  // bare Windows backslashes is not that form and stays as it is.
  it("does not unwrap a line whose unquoted backslashes it cannot read", () => {
    const line = "C:\\Windows\\System32\\cmd.exe /c type C:\\a\\b.txt";
    expect(unwrapWindowsShellCommand(line)).toBeNull();
    expect(deriveLiteralCommand(line)).toBe(line);
    expect(deriveCommandReadTargets(line)).toBeNull();
  });

  it("leaves everything else alone", () => {
    expect(unwrapWindowsShellCommand("git status")).toBeNull();
    expect(unwrapWindowsShellCommand("powershell -File script.ps1")).toBeNull();
    expect(unwrapWindowsShellCommand(`${POWERSHELL_EXE} -Command "unterminated`)).toBeNull();
  });
});

describe("command rows behind a Windows launcher", () => {
  const read = `${POWERSHELL_EXE} -Command "Get-Content -Raw 'C:/Users/person/.agents/skills/imagegen/SKILL.md'"`;

  it("name the real command and read files as reads", () => {
    expect(deriveLiteralCommand(read)).toBe(
      "Get-Content -Raw 'C:/Users/person/.agents/skills/imagegen/SKILL.md'",
    );
    expect(deriveCommandReadTargets(read)).toEqual(["imagegen/SKILL.md"]);
    expect(resolveCommandVisualKind(read)).toBe("read");
    expect(resolveCommandVisualKind(`${POWERSHELL_EXE} -Command "rg --files -g '*'"`)).toBe(
      "search",
    );
    expect(
      deriveCommandReadTargets(`${POWERSHELL_EXE} -Command "Get-Content -TotalCount 5 notes.txt"`),
    ).toEqual(["notes.txt"]);
  });

  it("do not call a pipeline a read", () => {
    expect(
      deriveCommandReadTargets(
        `${POWERSHELL_EXE} -Command 'Get-ChildItem -Force outputs | Select-Object Name,Length'`,
      ),
    ).toBeNull();
    expect(
      deriveLiteralCommand(
        `${POWERSHELL_EXE} -Command 'Get-ChildItem -Force outputs | Select-Object Name,Length'`,
      ),
    ).toBe("Get-ChildItem -Force outputs | Select-Object Name,Length");
  });

  it("show the real command in the Shell details", () => {
    expect(normalizeShellCommand(read)).toBe(
      "Get-Content -Raw 'C:/Users/person/.agents/skills/imagegen/SKILL.md'",
    );
  });
});

// Lead review of #648: a row may say "read" only when the whole command is
// provably one read and nothing else; otherwise it says 已运行 with the command.
describe("a read is only a read when nothing else runs", () => {
  const ps = (script: string) => `${POWERSHELL_EXE} -Command "${script}"`;
  const psSingle = (script: string) => `${POWERSHELL_EXE} -Command '${script}'`;

  it("treats a line break as a separator (PowerShell and POSIX)", () => {
    for (const command of [
      ps("Get-Content a.txt\nRemove-Item b.txt"),
      ps("Get-Content a.txt\r\nRemove-Item b.txt"),
      "/bin/bash -lc 'cat a.txt\nrm b.txt'",
      "cat a.txt\nrm -rf b",
    ]) {
      expect(deriveCommandReadTargets(command), JSON.stringify(command)).toBeNull();
      expect(resolveCommandVisualKind(command), JSON.stringify(command)).toBe("terminal");
      expect(deriveReadableCommandDisplay(command).target).not.toBe("a.txt, Remove-Item, b.txt");
    }
  });

  it("does not read through PowerShell sub-expressions", () => {
    for (const command of [
      ps("Get-Content (Remove-Item x -PassThru)"),
      ps("Get-Content @(Remove-Item x -PassThru)"),
      psSingle('Get-Content "$(Remove-Item x)"'),
      psSingle("Get-Content { Remove-Item x }"),
    ]) {
      expect(deriveCommandReadTargets(command), command).toBeNull();
    }
    // POSIX substitution inside double quotes runs too.
    expect(deriveCommandReadTargets('cat "$(rm x)"')).toBeNull();
    expect(deriveCommandReadTargets("/bin/zsh -lc 'cat \"`rm x`\"'")).toBeNull();
  });

  it("sees a separator after a PowerShell path ending in a backslash", () => {
    // `\` is not an escape character in PowerShell: the quote closes, then `;`.
    const command = psSingle('Get-Content "C:\\dir\\"; Remove-Item x');
    expect(deriveCommandReadTargets(command)).toBeNull();
    expect(resolveCommandVisualKind(command)).toBe("terminal");
  });

  it("reads Get-Content only with parameters it knows", () => {
    expect(
      deriveCommandReadTargets(ps("Get-Content a.txt -ErrorAction SilentlyContinue")),
    ).toBeNull();
    expect(deriveCommandReadTargets(ps("Get-Content -ea 0 a.txt"))).toBeNull();
    expect(deriveCommandReadTargets(ps("Get-Content a.txt -OutVariable x"))).toBeNull();
    expect(deriveCommandReadTargets(ps("Get-Content -Path . -Filter *.md"))).toBeNull();
    expect(deriveCommandReadTargets(ps("Get-Content $p"))).toBeNull();
    expect(deriveCommandReadTargets(ps("Get-Content -Tail 5 a.txt"))).toEqual(["a.txt"]);
    expect(deriveCommandReadTargets(ps("Get-Content -Encoding utf8 -Raw a.txt"))).toEqual([
      "a.txt",
    ]);
    expect(deriveCommandReadTargets(ps("Get-Content -LiteralPath 'C:\\dir\\a.txt'"))).toEqual([
      "dir/a.txt",
    ]);
    expect(deriveCommandReadTargets(ps("gc -Path a.txt -TotalCount 3"))).toEqual(["a.txt"]);
  });

  it("names the file, not an option value, in the row preview", () => {
    expect(deriveReadableCommandDisplay("Get-Content -Tail 5 a.txt").target).toBe("a.txt");
    expect(deriveReadableCommandDisplay("Get-Content -Encoding utf8 a.txt").target).toBe("a.txt");
    const unknown = deriveReadableCommandDisplay("Get-Content a.txt -ErrorAction SilentlyContinue");
    expect(unknown.verb).not.toBe("Read");
    expect(unknown.target).toContain("-ErrorAction SilentlyContinue");
  });

  it("treats `type` as a reader only under cmd and PowerShell", () => {
    expect(deriveCommandReadTargets("/bin/zsh -lc 'type node'")).toBeNull();
    expect(deriveCommandReadTargets("type node")).toBeNull();
    expect(resolveCommandVisualKind("/bin/zsh -lc 'type node'")).toBe("terminal");
    expect(deriveCommandReadTargets('cmd.exe /d /s /c "type notes.txt"')).toEqual(["notes.txt"]);
    expect(deriveCommandReadTargets(ps("type notes.txt"))).toEqual(["notes.txt"]);
  });

  it("does not call a search a search when more runs after it", () => {
    expect(resolveCommandVisualKind(ps("rg foo\nRemove-Item b.txt"))).toBe("terminal");
    expect(resolveCommandVisualKind("rg foo; rm -rf b")).toBe("terminal");
    expect(resolveCommandVisualKind("rg -n foo src")).toBe("search");
  });
});

// The owner's 2026-11-21 Codex turn: every row read "Ran $env:NO_PROXY=…" because
// the proxy and PATH lines came first. The row names the command that does the
// work; the details below it still hold the whole line.
describe("command rows behind Windows setup lines", () => {
  // Codex stores the -Command text POSIX-quoted, backslashes doubled.
  const psLine = (script: string) =>
    `${POWERSHELL_EXE} -Command "${script.replaceAll("\\", "\\\\")}"`;
  const PROXY_SETUP =
    "$env:NO_PROXY='127.0.0.1,localhost'; Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:ALL_PROXY -ErrorAction SilentlyContinue";
  const BUN_PATH = "$env:PATH='E:\\DevEnvs\\moss-synara\\bun-1.4.4\\bun-windows-x64;'+$env:PATH";

  it("skips proxy, PATH and folder setup and names the program", () => {
    expect(
      deriveLiteralCommand(
        psLine(
          `${PROXY_SETUP}; ${BUN_PATH}; Set-Location D:/work; & 'E:\\DevEnvs\\moss-synara\\bun-1.4.4\\bun-windows-x64\\bun.exe' run test apps/server/src/wsRpc.test.ts`,
        ),
      ),
    ).toBe("bun run test apps/server/src/wsRpc.test.ts");
    expect(deriveLiteralCommand("set NO_PROXY=localhost && npm test")).toBe("npm test");
  });

  it("reads a search behind setup lines as a search", () => {
    const command = psLine(`${PROXY_SETUP}; rg -n serverGetSettings apps/server/src`);
    expect(resolveCommandVisualKind(command)).toBe("search");
    expect(deriveLiteralCommand(command)).toBe("rg -n serverGetSettings apps/server/src");
  });

  it("keeps a line that is only setup, and script blocks after the call operator", () => {
    expect(deriveLiteralCommand("$env:NO_PROXY='localhost'")).toBe("$env:NO_PROXY='localhost'");
    expect(deriveLiteralCommand("& { Get-Date }")).toBe("& { Get-Date }");
  });
});
