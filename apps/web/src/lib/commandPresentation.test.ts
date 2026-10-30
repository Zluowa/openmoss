import { describe, expect, it } from "vitest";
import { literalCommandWords, skillScriptCommand } from "./commandPresentation";

describe("literal command presentation", () => {
  it("recognizes quoted skill scripts, system skills and installed plugins", () => {
    expect(literalCommandWords('python3 -u "/tmp/a b.py"')).toEqual([
      "python3",
      "-u",
      "/tmp/a b.py",
    ]);
    for (const path of [
      "/home/user/.codex/skills/.system/pdf/scripts/render.py",
      "/home/user/.agents/skills/pdf/scripts/render.py",
      "/home/user/.claude/skills/pdf/scripts/render.py",
      "/home/user/.codex/plugins/cache/bundled/pdf/1.0/skills/pdf/scripts/render.py",
    ])
      expect(skillScriptCommand(`python3 -u '${path}'`)).toEqual({
        fileName: "render.py",
        skillName: "PDF",
      });
  });

  it.each([
    "python3 scripts/render.py",
    "node /x/.codex/skills/pdf/scripts/render.py",
    "python3 /x/.codex/skills/pdf/references/render.py",
    "python3 /x/.codex/skills/pdf/scripts/render.py && rm result",
    'python3 "$HOME/.codex/skills/pdf/scripts/render.py"',
    "python3 -c '/x/.codex/skills/pdf/scripts/render.py'",
    "bash -ec '/x/.codex/skills/pdf/scripts/render.py'",
    "python3 '/x/.codex/skills/pdf/scripts/render.py",
  ])("keeps uncertain invocations generic: %s", (command) => {
    expect(skillScriptCommand(command)).toBeNull();
  });
});
