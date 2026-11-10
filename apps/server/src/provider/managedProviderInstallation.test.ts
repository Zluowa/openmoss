// FILE: managedProviderInstallation.test.ts
// Purpose: Proves managed removal preserves user files and rejects changed/outside targets.
// Layer: Provider filesystem lifecycle tests
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProviderInstallationRemovalAllowed,
  inspectProviderInstallation,
  removeManagedProviderInstallation,
} from "./managedProviderInstallation.ts";
import { LAUNCHER_CMD, LAUNCHER_PS1 } from "./cursorWindowsInstall.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      Path.dirname(Path.resolve(root)) !== Path.resolve(OS.tmpdir()) ||
      !Path.basename(root).startsWith("moss-removal-")
    )
      throw new Error("Unexpected cleanup target");
    await FS.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const mossHomeDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "moss-removal-"));
  roots.push(mossHomeDir);
  const prefix = Path.join(mossHomeDir, "agents");
  const pkg = Path.join(prefix, "node_modules", "opencode-ai");
  await FS.mkdir(pkg, { recursive: true });
  await FS.writeFile(
    Path.join(pkg, "package.json"),
    JSON.stringify({ name: "opencode-ai", bin: { opencode: "bin/opencode.js" } }),
  );
  const bin = process.platform === "win32" ? prefix : Path.join(prefix, "bin");
  await FS.mkdir(bin, { recursive: true });
  const shims = (process.platform === "win32" ? ["", ".cmd", ".ps1"] : [""]).map((ext) =>
    Path.join(bin, `opencode${ext}`),
  );
  for (const shim of shims) await FS.writeFile(shim, "node_modules/opencode-ai/bin/opencode.js");
  const account = Path.join(mossHomeDir, "accounts", "opencode", "history.json");
  await FS.mkdir(Path.dirname(account), { recursive: true });
  await FS.writeFile(account, "user-history");
  const external = Path.join(mossHomeDir, "outside-cli");
  await FS.writeFile(external, "user-owned");
  return {
    mossHomeDir,
    prefix,
    pkg,
    shims,
    account,
    external,
    input: { provider: "opencode" as const, mossHomeDir, binaryPath: shims[0]!, bundled: false },
  };
}

describe("managed agent installation", () => {
  it("requires every account to be disabled, including an additional account of the same agent", () => {
    expect(() =>
      assertProviderInstallationRemovalAllowed("opencode", {
        instances: [
          { driver: "opencode", enabled: false },
          { driver: "opencode", enabled: true },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("Turn this agent off"),
        code: "PROVIDER_INSTALLATION_AGENT_ENABLED",
      }),
    );
    expect(() =>
      assertProviderInstallationRemovalAllowed("opencode", {
        instances: [
          { driver: "opencode", enabled: false },
          { driver: "pi", enabled: true },
        ],
      }),
    ).not.toThrow();
  });
  it("rejects every unfinished session of the agent and accepts closed or unrelated sessions", () => {
    for (const status of ["connecting", "ready", "running", "error"] as const) {
      expect(() =>
        assertProviderInstallationRemovalAllowed("opencode", {
          sessions: [{ provider: "opencode", status }],
        }),
      ).toThrow(
        expect.objectContaining({
          message: expect.stringContaining("Finish this agent"),
          code: "PROVIDER_INSTALLATION_SESSIONS_RUNNING",
        }),
      );
    }
    expect(() =>
      assertProviderInstallationRemovalAllowed("opencode", {
        sessions: [
          { provider: "opencode", status: "closed" },
          { provider: "pi", status: "running" },
        ],
      }),
    ).not.toThrow();
  });
  it("reports the chosen program and only offers removal for an identified managed package", async () => {
    const f = await fixture();
    expect(await inspectProviderInstallation(f.input)).toMatchObject({
      source: "moss",
      canUninstall: true,
      managedPath: f.pkg,
    });
    expect(await inspectProviderInstallation({ ...f.input, binaryPath: f.external })).toMatchObject(
      { source: "external", path: f.external, canUninstall: true },
    );
    expect(await inspectProviderInstallation({ ...f.input, bundled: true })).toMatchObject({
      source: "bundled",
    });
  });

  it("removes commands and package together, retaining account/history, other agents and external installs", async () => {
    const f = await fixture();
    const sibling = Path.join(f.prefix, "node_modules", "other-agent", "keep");
    await FS.mkdir(Path.dirname(sibling), { recursive: true });
    await FS.writeFile(sibling, "keep");
    expect(await removeManagedProviderInstallation(f.input)).toBe(true);
    for (const removed of [f.pkg, ...f.shims]) await expect(FS.stat(removed)).rejects.toThrow();
    expect(await FS.readFile(f.account, "utf8")).toBe("user-history");
    expect(await FS.readFile(f.external, "utf8")).toBe("user-owned");
    expect(await FS.readFile(sibling, "utf8")).toBe("keep");
    const backups = await FS.readdir(Path.join(f.prefix, ".removed"));
    expect(backups).toHaveLength(1);
    expect((await FS.readdir(Path.join(f.prefix, ".removed", backups[0]!))).length).toBe(
      f.shims.length + 1,
    );
  });

  it("rejects a launcher changed outside Moss before moving any file", async () => {
    const f = await fixture();
    await FS.writeFile(f.shims[0]!, "external/custom-program");
    await expect(removeManagedProviderInstallation(f.input)).rejects.toMatchObject({
      message: expect.stringContaining("changed outside Moss"),
      code: "PROVIDER_INSTALLATION_MODIFIED",
    });
    expect(await FS.readFile(Path.join(f.pkg, "package.json"), "utf8")).toContain("opencode-ai");
    expect(await FS.readFile(f.shims[0]!, "utf8")).toBe("external/custom-program");
  });

  it("reports an unchanged selected program when removing only an idle Moss copy", async () => {
    const f = await fixture();
    const input = { ...f.input, binaryPath: f.external };
    expect((await inspectProviderInstallation(input)).source).toBe("external");
    expect(await removeManagedProviderInstallation(input)).toBe(false);
    expect(await FS.readFile(f.external, "utf8")).toBe("user-owned");
    await expect(FS.stat(f.pkg)).rejects.toThrow();
  });

  it("rolls back earlier moves if a later file is locked or cannot be moved", async () => {
    const f = await fixture();
    let calls = 0;
    await expect(
      removeManagedProviderInstallation(f.input, {
        rename: async (from, to) => {
          if (++calls === 2) throw new Error("locked");
          return FS.rename(from, to);
        },
      }),
    ).rejects.toThrow("locked");
    for (const shim of f.shims) expect(await FS.readFile(shim, "utf8")).toContain("opencode-ai");
    expect((await FS.stat(f.pkg)).isDirectory()).toBe(true);
  });

  it("says the agent is still in use when Windows refuses to move an open file", async () => {
    const f = await fixture();
    let calls = 0;
    await expect(
      removeManagedProviderInstallation(f.input, {
        rename: async (from, to) => {
          if (++calls === 2)
            throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
          return FS.rename(from, to);
        },
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_INSTALLATION_IN_USE" });
    for (const shim of f.shims) expect(await FS.readFile(shim, "utf8")).toContain("opencode-ai");
    expect((await FS.stat(f.pkg)).isDirectory()).toBe(true);
  });

  it("will not follow a package junction outside the managed prefix", async () => {
    const f = await fixture();
    const original = Path.join(f.mossHomeDir, "outside-package");
    await FS.rename(f.pkg, original);
    await FS.symlink(original, f.pkg, process.platform === "win32" ? "junction" : "dir");
    expect((await inspectProviderInstallation(f.input)).canUninstall).toBe(false);
    await expect(removeManagedProviderInstallation(f.input)).rejects.toMatchObject({
      message: expect.stringContaining("No removable"),
      code: "PROVIDER_INSTALLATION_NOT_FOUND",
    });
    expect((await FS.stat(original)).isDirectory()).toBe(true);
  });

  it("removes the audited native Cursor wrapper and its versions without touching external Cursor", async () => {
    const f = await fixture();
    const root = Path.join(f.prefix, "cursor");
    await FS.mkdir(root);
    await FS.writeFile(Path.join(root, "resolve-version.ps1"), LAUNCHER_PS1);
    await FS.writeFile(Path.join(root, "active-version"), "2026.11.05-86047df-x64");
    const shim = Path.join(f.prefix, "cursor-agent.cmd");
    await FS.writeFile(shim, LAUNCHER_CMD);
    const input = { ...f.input, provider: "cursor" as const, binaryPath: shim };
    expect((await inspectProviderInstallation(input)).canUninstall).toBe(true);
    await removeManagedProviderInstallation(input);
    await expect(FS.stat(shim)).rejects.toThrow();
    await expect(FS.stat(root)).rejects.toThrow();
    expect(await FS.readFile(f.external, "utf8")).toBe("user-owned");
  });
});
