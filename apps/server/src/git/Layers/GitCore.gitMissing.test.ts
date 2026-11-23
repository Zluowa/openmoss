import { describe, expect, it } from "vitest";
import * as PlatformError from "effect/PlatformError";
import { GIT_NOT_INSTALLED_DETAIL, isGitNotInstalledErrorMessage } from "@moss/shared/git";

import { isGitProgramMissing } from "./GitCore.ts";

// WALK-1 R-1: with no git on PATH the changes panel printed
// "Git command failed in GitCore.listBranches.branchNoColor: git branch --no-color (...) -
// NotFound: ChildProcess.spawn (git branch --no-color) - failed to spawn."
const spawnNotFound = () =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: "git branch --no-color",
  });

describe("git that is not installed", () => {
  it("is recognised from the spawn failure the platform reports", () => {
    expect(isGitProgramMissing(spawnNotFound())).toBe(true);
    expect(spawnNotFound().message).toContain("NotFound: ChildProcess.spawn");
  });

  it("is not confused with a missing file or a failed git run", () => {
    expect(
      isGitProgramMissing(
        PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "stat" }),
      ),
    ).toBe(false);
    expect(
      isGitProgramMissing(
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "ChildProcess",
          method: "spawn",
        }),
      ),
    ).toBe(false);
    expect(isGitProgramMissing(new Error("fatal: not a git repository"))).toBe(false);
    expect(isGitProgramMissing(undefined)).toBe(false);
  });

  it("reaches the window as one sentence it can recognise", () => {
    const wireMessage = `Git command failed in GitCore.listBranches.branchNoColor: git branch --no-color (D:\demo) - ${GIT_NOT_INSTALLED_DETAIL}`;
    expect(isGitNotInstalledErrorMessage(wireMessage)).toBe(true);
    expect(
      isGitNotInstalledErrorMessage(
        "Git command failed in GitCore.listBranches.branchNoColor: git branch --no-color (D:\demo) - fatal: bad object",
      ),
    ).toBe(false);
  });
});
