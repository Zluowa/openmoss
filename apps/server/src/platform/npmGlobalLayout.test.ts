import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { npmGlobalBinDirectory, npmGlobalLauncherSuffixes } from "./npmGlobalLayout.ts";

describe("npmGlobalLayout", () => {
  it("puts Windows launchers in the prefix as name, name.cmd and name.ps1", () => {
    expect(npmGlobalBinDirectory("C:/moss/agents", "win32")).toBe("C:/moss/agents");
    expect(npmGlobalLauncherSuffixes("win32")).toEqual(["", ".cmd", ".ps1"]);
  });

  it("puts POSIX launchers in prefix/bin as one file per command", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(npmGlobalBinDirectory("/moss/agents", platform)).toBe(
        NodePath.join("/moss/agents", "bin"),
      );
      expect(npmGlobalLauncherSuffixes(platform)).toEqual([""]);
    }
  });
});
