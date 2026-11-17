// Command rows for Codex on Windows: Codex launches every command through
// PowerShell (or cmd) and persists the launcher line, quoted the POSIX way.
// The lines below are copied from the owner's 2026-11-17 chat
// (round 20261117-owner-test); the user name is redacted.

import { describe, expect, it } from "vitest";

import { normalizeShellCommand } from "../components/chat/CommandShellDetails.logic";
import {
  deriveCommandReadTargets,
  deriveLiteralCommand,
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

  it("skips launcher switches and handles pwsh and cmd", () => {
    expect(unwrapWindowsShellCommand("pwsh -NoProfile -ExecutionPolicy Bypass -Command 'ls'")).toBe(
      "ls",
    );
    expect(unwrapWindowsShellCommand('cmd.exe /d /s /c "dir /b"')).toBe("dir /b");
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
