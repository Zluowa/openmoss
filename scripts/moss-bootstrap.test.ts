import { describe, expect, it } from "vitest";

import type { EnsureMossSourceResult } from "@synara/shared/mossSourceBootstrap";

import { mossBootstrapExitCode, parseBootstrapWorkspace } from "./moss-bootstrap";

function resultWithStatus(status: EnsureMossSourceResult["status"]): EnsureMossSourceResult {
  return {
    projectPath: "/workspace/demo",
    root: "/workspace/demo/.moss",
    status,
    created: [],
    skipped: [],
    conflicts: [],
  };
}

describe("parseBootstrapWorkspace", () => {
  it("defaults to the current working directory", () => {
    expect(parseBootstrapWorkspace([], "/fallback/cwd")).toBe("/fallback/cwd");
  });

  it("reads --workspace <path>", () => {
    expect(parseBootstrapWorkspace(["--workspace", "/tmp/w"], "/fallback/cwd")).toBe("/tmp/w");
  });

  it("rejects --workspace without a value", () => {
    expect(() => parseBootstrapWorkspace(["--workspace"], "/fallback/cwd")).toThrow(
      "--workspace requires a path",
    );
  });

  it("rejects unknown options", () => {
    expect(() => parseBootstrapWorkspace(["--nope"], "/fallback/cwd")).toThrow(
      "unknown moss bootstrap option: --nope",
    );
  });
});

describe("mossBootstrapExitCode", () => {
  it("exits zero for created/updated/skipped and non-zero for conflict", () => {
    expect(mossBootstrapExitCode(resultWithStatus("created"))).toBe(0);
    expect(mossBootstrapExitCode(resultWithStatus("updated"))).toBe(0);
    expect(mossBootstrapExitCode(resultWithStatus("skipped"))).toBe(0);
    expect(mossBootstrapExitCode(resultWithStatus("conflict"))).toBe(1);
  });
});
