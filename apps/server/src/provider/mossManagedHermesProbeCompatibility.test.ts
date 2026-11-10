import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildMossManagedHermesConfig,
  prepareMossManagedHermesHome,
} from "./mossManagedHermesEnvironment";
import {
  MOSS_HERMES_PROBE_PLUGIN_NAME,
  MOSS_HERMES_PROBE_PLUGIN_SOURCE,
  mossHermesProbeIssue,
  readMossHermesProbeStatus,
} from "./mossManagedHermesProbePlugin";

const config = buildMossManagedHermesConfig("https://moss-test.example/v1", "enterprise");
async function fixture(run: (root: string, plugin: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "moss-hermes-plugin-")));
  try {
    await run(root, path.join(root, "plugins", MOSS_HERMES_PROBE_PLUGIN_NAME));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Moss managed Hermes Windows probe plugin", () => {
  it("publishes exact complete bytes idempotently and explicitly enables itself for ACP", () =>
    fixture(async (root, plugin) => {
      await prepareMossManagedHermesHome(root, config, "win32");
      await prepareMossManagedHermesHome(root, config, "win32");
      expect(await readFile(path.join(plugin, "__init__.py"), "utf8")).toBe(
        MOSS_HERMES_PROBE_PLUGIN_SOURCE,
      );
      expect((await readdir(path.join(root, "plugins"))).sort()).toEqual([
        MOSS_HERMES_PROBE_PLUGIN_NAME,
      ]);
      expect(JSON.parse(await readFile(path.join(root, "config.yaml"), "utf8"))).toEqual({
        ...config.configuration,
        plugins: { enabled: [MOSS_HERMES_PROBE_PLUGIN_NAME] },
      });
    }));
  it("retains all existing plugin choices and adds only its own explicit enable entry", () =>
    fixture(async (root) => {
      await writeFile(
        path.join(root, "config.yaml"),
        "plugins:\n  enabled: [one, two]\n  disabled: [three]\n  entries:\n    one: {config: {value: keep}}\n",
      );
      await prepareMossManagedHermesHome(root, config, "win32");
      const saved = JSON.parse(await readFile(path.join(root, "config.yaml"), "utf8"));
      expect(saved.plugins).toEqual({
        enabled: ["one", "two", MOSS_HERMES_PROBE_PLUGIN_NAME],
        disabled: ["three"],
        entries: { one: { config: { value: "keep" } } },
      });
    }));
  it("does not overwrite an explicit disable or malformed config", () =>
    fixture(async (root) => {
      for (const original of [
        JSON.stringify({ plugins: { disabled: [MOSS_HERMES_PROBE_PLUGIN_NAME] } }),
        "plugins: [broken]",
        "plugins: {enabled: nope}",
        "plugins: [",
      ]) {
        await writeFile(path.join(root, "config.yaml"), original);
        await expect(prepareMossManagedHermesHome(root, config, "win32")).rejects.toThrow(
          /disabled|read safely/,
        );
        expect(await readFile(path.join(root, "config.yaml"), "utf8")).toBe(original);
      }
      expect(await readdir(root)).not.toContain("plugins");
    }));
  it("refuses same-name foreign files and preserves config and plugin contents", () =>
    fixture(async (root, plugin) => {
      await mkdir(plugin, { recursive: true });
      await writeFile(path.join(plugin, "__init__.py"), "# user plugin");
      await writeFile(path.join(root, "config.yaml"), "plugins: {enabled: [one]}");
      await expect(prepareMossManagedHermesHome(root, config, "win32")).rejects.toThrow(
        "conflicts",
      );
      expect(await readFile(path.join(plugin, "__init__.py"), "utf8")).toBe("# user plugin");
      expect(await readFile(path.join(root, "config.yaml"), "utf8")).toBe(
        "plugins: {enabled: [one]}",
      );
    }));
  it("rejects linked plugin directories without writing into their target", () =>
    fixture(async (root, plugin) => {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await mkdir(path.dirname(plugin));
      await symlink(outside, plugin, process.platform === "win32" ? "junction" : "dir");
      await expect(prepareMossManagedHermesHome(root, config, "win32")).rejects.toThrow("symlink");
      expect(await readdir(outside)).toEqual([]);
    }));
  it("accepts ordinary Python bytecode but refuses unknown extra plugin source", () =>
    fixture(async (root, plugin) => {
      await prepareMossManagedHermesHome(root, config, "win32");
      await mkdir(path.join(plugin, "__pycache__"));
      await prepareMossManagedHermesHome(root, config, "win32");
      await writeFile(path.join(plugin, "other.py"), "# foreign");
      await expect(prepareMossManagedHermesHome(root, config, "win32")).rejects.toThrow(
        "conflicts",
      );
      expect(await readFile(path.join(plugin, "other.py"), "utf8")).toBe("# foreign");
    }));
  it("leaves Linux and macOS materialization unchanged", () =>
    fixture(async (root) => {
      for (const platform of ["linux", "darwin"] as const) {
        await prepareMossManagedHermesHome(root, config, platform);
        expect(JSON.parse(await readFile(path.join(root, "config.yaml"), "utf8"))).toEqual(
          config.configuration,
        );
        expect(await readdir(root)).not.toContain("plugins");
      }
    }));
  it("only accepts closed status markers and never exposes arbitrary child details", () => {
    expect(readMossHermesProbeStatus("MOSS_HERMES_PROBE_COMPAT_V1:applied")).toBe("applied");
    expect(mossHermesProbeIssue("already-bounded")).toBeUndefined();
    for (const line of [
      "MOSS_HERMES_PROBE_COMPAT_V1:applied secret",
      "prompt\nMOSS_HERMES_PROBE_COMPAT_V1:applied",
      "MOSS_HERMES_PROBE_COMPAT_V1:unknown-secret",
    ])
      expect(readMossHermesProbeStatus(line)).toBeUndefined();
    expect(mossHermesProbeIssue(undefined)).toContain("did not load");
  });
  it.runIf(Boolean(process.env.MOSS_HERMES_TEST_PYTHON))(
    "executes fingerprint, helper, bytes and unload contracts with stdlib fake modules",
    () =>
      fixture(async (root, plugin) => {
        await prepareMossManagedHermesHome(root, config, "win32");
        const script = fileURLToPath(
          new URL("./fixtures/hermesProbePlugin.test.py", import.meta.url),
        );
        const result = await promisify(execFile)(
          process.env.MOSS_HERMES_TEST_PYTHON!,
          ["-I", "-B", script, path.join(plugin, "__init__.py")],
          { timeout: 10_000, windowsHide: true },
        );
        expect(result.stderr).toContain("Ran 10 tests");
        expect(result.stderr).toContain("OK");
      }),
  );
});
