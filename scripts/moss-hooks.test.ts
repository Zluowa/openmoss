import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import OS from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MOSS_SESSION_START_EVENT, discoverMossHooks } from "@synara/shared/mossHooks";
import { getMossSourceLayout } from "@synara/shared/mossSourceLayout";

import { parseMossHooksCliArgs, renderHookList, runMossHooksCli } from "./moss-hooks";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(OS.tmpdir(), "t3-moss-hooks-cli-"));
  tempDirs.push(workspace);
  await mkdir(getMossSourceLayout(workspace).hooksRoot, { recursive: true });
  return workspace;
}

async function writeHook(workspace: string, name: string, command: string): Promise<void> {
  await writeFile(
    join(getMossSourceLayout(workspace).hooksRoot, `${name}.md`),
    `---\nname: ${name}\nevent: ${MOSS_SESSION_START_EVENT}\ncommand: ${command}\nenabled: true\n---\nBody.\n`,
    "utf8",
  );
}

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("parseMossHooksCliArgs", () => {
  it("parses list with workspace and json flags", () => {
    expect(parseMossHooksCliArgs(["list", "--workspace", "/tmp/w", "--json"], "/cwd")).toEqual({
      action: "list",
      workspace: "/tmp/w",
      json: true,
      all: false,
    });
  });

  it("parses trust <name> and trust --all", () => {
    expect(parseMossHooksCliArgs(["trust", "session-start"], "/cwd")).toEqual({
      action: "trust",
      workspace: "/cwd",
      json: false,
      all: false,
      hookName: "session-start",
    });
    expect(parseMossHooksCliArgs(["trust", "--all"], "/cwd")).toEqual({
      action: "trust",
      workspace: "/cwd",
      json: false,
      all: true,
    });
  });

  it("rejects unknown commands, missing targets, and conflicting targets", () => {
    expect(() => parseMossHooksCliArgs([], "/cwd")).toThrow("unknown moss hooks command");
    expect(() => parseMossHooksCliArgs(["nope"], "/cwd")).toThrow("unknown moss hooks command");
    expect(() => parseMossHooksCliArgs(["trust"], "/cwd")).toThrow(
      "trust requires a hook name or --all",
    );
    expect(() => parseMossHooksCliArgs(["trust", "a", "--all"], "/cwd")).toThrow(
      "either a hook name or --all",
    );
    expect(() => parseMossHooksCliArgs(["list", "--workspace"], "/cwd")).toThrow(
      "--workspace requires a path",
    );
  });
});

describe("runMossHooksCli", () => {
  it("lists hooks with their trust state", async () => {
    const workspace = await makeWorkspace();
    await writeHook(workspace, "starter", "echo hi");

    let output = "";
    await runMossHooksCli(
      { action: "list", workspace, json: false, all: false },
      (text) => (output += text),
    );

    expect(output).toContain("starter");
    expect(output).toContain("untrusted");
    expect(renderHookList([])).toBe("no .moss hooks discovered\n");
  });

  it("trust <name> flips the hook to trusted at its current hash", async () => {
    const workspace = await makeWorkspace();
    await writeHook(workspace, "starter", "echo hi");

    let output = "";
    await runMossHooksCli(
      { action: "trust", workspace, json: false, all: false, hookName: "starter" },
      (text) => (output += text),
    );

    expect(JSON.parse(output)).toEqual({ trusted: ["starter"] });
    const [resource] = await discoverMossHooks(workspace);
    expect(resource?.trustState).toBe("trusted");
  });

  it("trust --all trusts every discovered hook", async () => {
    const workspace = await makeWorkspace();
    await writeHook(workspace, "one", "echo one");
    await writeHook(workspace, "two", "echo two");

    let output = "";
    await runMossHooksCli(
      { action: "trust", workspace, json: false, all: true },
      (text) => (output += text),
    );

    expect(JSON.parse(output)).toEqual({ trusted: ["one", "two"] });
    const resources = await discoverMossHooks(workspace);
    expect(resources.map((resource) => resource.trustState)).toEqual(["trusted", "trusted"]);
  });

  it("fails with a clear error for an unknown hook name", async () => {
    const workspace = await makeWorkspace();
    await expect(
      runMossHooksCli(
        { action: "trust", workspace, json: false, all: false, hookName: "ghost" },
        () => {},
      ),
    ).rejects.toThrow("no .moss hook named 'ghost'");
  });
});
