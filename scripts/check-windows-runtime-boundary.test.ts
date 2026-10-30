import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const controllerPath = "apps/server/src/platform/processTreeController.ts";
const safeTreeCommand = `spawnProcessSync(
  resolveWindowsSystemExecutable(["System32", "taskkill.exe"]),
  ["/pid", String(numericPid), "/T", "/F"],
  { stdio: "ignore", timeout: 2_000 },
);`;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function check(source: string, file = controllerPath) {
  const directory = mkdtempSync(path.join(tmpdir(), "moss-windows-boundary-"));
  directories.push(directory);
  const files = {
    "scripts/check-windows-runtime-boundary.ts": readFileSync(
      new URL("./check-windows-runtime-boundary.ts", import.meta.url),
      "utf8",
    ),
    "apps/server/src/open.ts": "",
    "apps/server/src/processRunner.ts": "",
    [file]: source,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = path.join(directory, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  return spawnSync(
    process.execPath,
    [path.join(directory, "scripts/check-windows-runtime-boundary.ts")],
    {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
}

describe("Windows process boundary guard", () => {
  it("accepts the owner's System32 command through the shared synchronous launcher", () => {
    const result = check(safeTreeCommand);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Windows runtime boundary verified");
  });

  it.each([
    'spawn("taskkill", ["/T", "/F"]);',
    'exec("taskkill /T /F");',
    'spawnProcessSync("C:/untrusted/taskkill.exe", []);',
    'spawnProcessSync(resolveWindowsSystemExecutable(["Other", "taskkill.exe"]), []);',
    'unsafe_spawnProcessSync(resolveWindowsSystemExecutable(["System32", "taskkill.exe"]), []);',
  ])("still rejects unsafe commands in the owner: %s", (unsafeCommand) => {
    const result = check(`${safeTreeCommand}\n${unsafeCommand}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${controllerPath}: Windows executable/tree commands`);
  });

  it("does not grant the owner's exception to provider code", () => {
    const file = "apps/server/src/provider/unownedTreeCleanup.ts";
    const result = check(safeTreeCommand, file);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}: Windows executable/tree commands`);
  });
});
