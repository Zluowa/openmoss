import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { createRejectedFileAlias } from "../../../../scripts/fixtures/filesystem-links.ts";

import {
  prepareMossManagedPluginStore,
  readMossManagedPluginConfig,
  syncMossManagedPluginConfig,
  writeMossManagedPluginConfig,
} from "./mossManagedPluginConfig.ts";

const homes: string[] = [];
async function setup(contents?: string) {
  const managedHomePath = await mkdtemp(path.join(tmpdir(), "moss-plugin-config-test-"));
  homes.push(managedHomePath);
  const configPath = path.join(managedHomePath, "config.toml");
  await writeFile(
    path.join(managedHomePath, ".moss-managed-home"),
    `moss-managed-codex-home-v2:${randomUUID()}\n`,
  );
  if (contents !== undefined) await writeFile(configPath, contents);
  return { managedHomePath, configPath };
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("managed native plugin config", () => {
  it("preserves install and disable choices plus custom marketplaces without overriding managed routing", async () => {
    const input = await setup(`model_provider = "untrusted"
[model_providers.untrusted]
base_url = "https://untrusted.example"
[plugins."moss-imagegen@moss-bundled"]
enabled = true
[plugins."custom@team"]
enabled = false
[plugins."custom@team".mcp_servers.mail]
enabled = false
disabled_tools = ["send_message"]
default_tools_approval_mode = "prompt"
[plugins."custom@team".mcp_servers.mail.tools.read_message]
approval_mode = "auto"
output_token_limit = 512
[plugins."inherited@team"]
[plugins._default]
enabled = false
[marketplaces.moss-bundled]
source_type = "local"
source = "/old/bundled/path"
[marketplaces.team]
source_type = "git"
source = "https://example.com/team/plugins.git"
ref = "stable"
sparse_paths = ["plugins", ".agents"]
`);
    const preserved = await readMossManagedPluginConfig(input);
    const refreshed = parse(
      `[model_providers.moss]\nbase_url = "https://gateway.example"\n[marketplaces.moss-bundled]\nsource_type = "local"\nsource = "/current/bundled/path"\n${preserved}`,
    );
    expect(refreshed).toEqual({
      model_providers: { moss: { base_url: "https://gateway.example" } },
      plugins: {
        "moss-imagegen@moss-bundled": { enabled: true },
        "custom@team": {
          enabled: false,
          mcp_servers: {
            mail: {
              enabled: false,
              disabled_tools: ["send_message"],
              default_tools_approval_mode: "prompt",
              tools: { read_message: { approval_mode: "auto", output_token_limit: 512 } },
            },
          },
        },
        "inherited@team": {},
        _default: { enabled: false },
      },
      marketplaces: {
        "moss-bundled": { source_type: "local", source: "/current/bundled/path" },
        team: {
          source_type: "git",
          source: "https://example.com/team/plugins.git",
          ref: "stable",
          sparse_paths: ["plugins", ".agents"],
        },
      },
    });
  });

  it("keeps fresh homes and explicit uninstalls empty", async () => {
    expect(await readMossManagedPluginConfig(await setup())).toBe("");
    expect(
      await readMossManagedPluginConfig(await setup('[model_providers.moss]\nname = "Moss"\n')),
    ).toBe("");
  });

  it("refuses invalid, oversized or linked files instead of silently erasing choices", async () => {
    const invalid = await setup('[plugins."broken@team"]\nenabled = "false"\n');
    await expect(readMossManagedPluginConfig(invalid)).rejects.toThrow(/enabled setting/);
    await writeFile(invalid.configPath, "#".repeat(1024 * 1024 + 1));
    await expect(readMossManagedPluginConfig(invalid)).rejects.toThrow(/file limit/);
    const target = await setup('[plugins."valid@team"]\nenabled = true\n');
    await rm(invalid.configPath);
    // Rejection-only on Windows: this is a junction in a regular-file slot.
    createRejectedFileAlias(target.configPath, invalid.configPath);
    await expect(readMossManagedPluginConfig(invalid)).rejects.toThrow(/regular file/);
    await expect(
      readMossManagedPluginConfig({ ...target, configPath: invalid.configPath }),
    ).rejects.toThrow(/verified managed home/);
  });

  it("persists native overlay mutations without copying runtime routing or gateway credentials", async () => {
    const source = await setup(
      'model_provider = "moss"\n[marketplaces.moss-bundled]\nsource_type = "local"\nsource = "/owned/source"\n[plugins."old@team"]\nenabled = true\n',
    );
    const runtime = await setup(
      'model_provider = "other"\n[mcp_servers.moss]\nbearer_token_env_var = "PRIVATE_RUNTIME_TOKEN"\n[plugins."new@team"]\nenabled = false\n[marketplaces.team]\nsource_type = "local"\nsource = "/team/plugins"\n',
    );
    await syncMossManagedPluginConfig({
      managedHomePath: source.managedHomePath,
      runtimeHomePath: runtime.managedHomePath,
      assertCurrent: () => undefined,
    });
    expect(parse(await readFile(source.configPath, "utf8"))).toEqual({
      model_provider: "moss",
      marketplaces: {
        "moss-bundled": { source_type: "local", source: "/owned/source" },
        team: { source_type: "local", source: "/team/plugins" },
      },
      plugins: { "new@team": { enabled: false } },
    });
    const before = await readFile(source.configPath, "utf8");
    await expect(
      syncMossManagedPluginConfig({
        managedHomePath: source.managedHomePath,
        runtimeHomePath: runtime.managedHomePath,
        assertCurrent: () => {
          throw new Error("Account changed");
        },
      }),
    ).rejects.toThrow("Account changed");
    expect(await readFile(source.configPath, "utf8")).toBe(before);
  });

  it("moves legacy runtime-only cache into the managed source without losing installed files", async () => {
    const source = await setup();
    const runtime = await setup();
    await writeFile(
      path.join(source.managedHomePath, ".moss-managed-home"),
      `moss-managed-codex-home-v2:${randomUUID()}\n`,
    );
    await mkdir(path.join(runtime.managedHomePath, "plugins", "cache"), { recursive: true });
    await writeFile(
      path.join(runtime.managedHomePath, "plugins", "cache", "installed.json"),
      "native installation",
    );
    await prepareMossManagedPluginStore({
      managedHomePath: source.managedHomePath,
      runtimeHomePath: runtime.managedHomePath,
    });
    expect(
      await readFile(
        path.join(source.managedHomePath, "plugins", "cache", "installed.json"),
        "utf8",
      ),
    ).toBe("native installation");
    await expect(
      readFile(path.join(runtime.managedHomePath, "plugins", "cache", "installed.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await symlink(
      path.join(source.managedHomePath, "plugins"),
      path.join(runtime.managedHomePath, "plugins"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      prepareMossManagedPluginStore({
        managedHomePath: source.managedHomePath,
        runtimeHomePath: runtime.managedHomePath,
      }),
    ).resolves.toBeUndefined();
  });

  it("serializes managed routing refreshes with native preference mutations", async () => {
    const source = await setup(
      'model_provider = "moss"\n[plugins."custom@team"]\nenabled = true\n',
    );
    const runtime = await setup('[plugins."custom@team"]\nenabled = false\n');
    await writeFile(
      path.join(source.managedHomePath, ".moss-managed-home"),
      "moss-managed-codex-home-v1\n",
    );
    await Promise.all([
      syncMossManagedPluginConfig({
        managedHomePath: source.managedHomePath,
        runtimeHomePath: runtime.managedHomePath,
        assertCurrent: () => undefined,
      }),
      writeMossManagedPluginConfig({
        ...source,
        generatedConfig: 'model_provider = "refreshed-moss"\n',
      }),
    ]);
    expect(parse(await readFile(source.configPath, "utf8"))).toEqual({
      model_provider: "refreshed-moss",
      plugins: { "custom@team": { enabled: false } },
    });
    await expect(
      writeMossManagedPluginConfig({
        ...source,
        generatedConfig: '[plugins."custom@team"]\nenabled = true\n',
      }),
    ).rejects.toThrow();
    expect(parse(await readFile(source.configPath, "utf8")).plugins).toEqual({
      "custom@team": { enabled: false },
    });
    await rm(path.join(source.managedHomePath, ".moss-managed-home"));
    await expect(
      writeMossManagedPluginConfig({ ...source, generatedConfig: 'model_provider = "moss"\n' }),
    ).rejects.toThrow();
  });

  it("recovers only proven empty staging and never discards possible plugin preferences", async () => {
    const source = await setup("stale staged config");
    await writeFile(
      path.join(source.managedHomePath, ".moss-managed-home"),
      `moss-managed-codex-home-v2:${randomUUID()}\n`,
    );
    const input = { ...source, generatedConfig: 'model_provider = "moss"\n' };
    await expect(writeMossManagedPluginConfig(input)).rejects.toThrow();
    await writeMossManagedPluginConfig({ ...input, recoverStagedConfig: true });
    expect(parse(await readFile(source.configPath, "utf8"))).toEqual({ model_provider: "moss" });
    await writeFile(source.configPath, '[plugins."custom@team"]\nenabled =');
    await expect(
      writeMossManagedPluginConfig({ ...input, recoverStagedConfig: true }),
    ).rejects.toThrow();
    await writeFile(source.configPath, "legacy config");
    await mkdir(path.join(source.managedHomePath, "plugins"));
    await expect(
      writeMossManagedPluginConfig({ ...input, recoverStagedConfig: true }),
    ).rejects.toThrow();
    expect(await readFile(source.configPath, "utf8")).toBe("legacy config");
  });

  it("rechecks service ownership after its atomic writer before returning success", async () => {
    const source = await setup();
    await writeFile(
      path.join(source.managedHomePath, ".moss-managed-home"),
      `moss-managed-codex-home-v2:${randomUUID()}\n`,
    );
    let current = true;
    await expect(
      writeMossManagedPluginConfig({
        ...source,
        generatedConfig: 'model_provider = "moss"\n',
        assertCurrent: () => {
          if (!current) throw new Error("Ownership nonce changed");
        },
        writeAtomically: async ({ filePath, contents }) => {
          await writeFile(filePath, contents);
          current = false;
        },
      }),
    ).rejects.toThrow("Ownership nonce changed");
  });
});
