import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { createRejectedFileAlias } from "../../../../scripts/fixtures/filesystem-links.ts";

import {
  installMossBundledPlugin,
  isTransientWindowsPluginInstallError,
  mutateMossManagedPluginConfig,
  prepareMossManagedPluginStore,
  readMossManagedPluginConfig,
  syncMossManagedPluginConfig,
  writeMossManagedPluginConfig,
} from "./mossManagedPluginConfig.ts";
import { bootstrapMossBundledPlugins } from "./mossBundledPluginBootstrap.ts";

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
  it("queues managed config regeneration behind an active native edit in the same home", async () => {
    const { managedHomePath, configPath } = await setup("model = 'old'\n");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const edited = mutateMossManagedPluginConfig(
      {
        managedHomePath,
        runtimeHomePath: managedHomePath,
        assertCurrent() {},
      },
      async () => {
        entered.resolve();
        await release.promise;
        await writeFile(configPath, '[plugins."local@market"]\nenabled=true\n');
      },
    );
    await entered.promise;
    const refreshed = writeMossManagedPluginConfig({
      managedHomePath,
      configPath,
      generatedConfig: "model = 'new'\n",
    });
    // A writer with an independent lock would finish while the native edit is paused.
    const first = await Promise.race([
      refreshed.then(() => "written"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    release.resolve();
    expect(first).toBe("pending");
    await Promise.all([edited, refreshed]);
    const config = parse(await readFile(configPath, "utf8"));
    expect(config.model).toBe("new");
    expect(config.plugins).toEqual({ "local@market": { enabled: true } });
  });

  it.runIf(process.platform === "win32").each([false, true])(
    "recovers a Windows replacement conflict only when the file can be replaced (permanent=%s)",
    async (permanent) => {
      const { managedHomePath, configPath } = await setup("model = 'kept'\n");
      const held = await open(configPath, "r");
      const attempts: string[] = [];
      const nativeError = new Error(
        "plugin/install failed: failed to persist installed plugin config: Access is denied. (os error 5)",
      );
      const boot = bootstrapMossBundledPlugins({
        expectedHomePath: managedHomePath,
        initializedHomePath: managedHomePath,
        homePath: managedHomePath,
        accountId: "moss",
        install: ({ pluginName }) =>
          installMossBundledPlugin({
            runtimeHomePath: managedHomePath,
            pluginName,
            assertCurrent() {},
            install: async () => {
              attempts.push(pluginName);
              const config = parse(await readFile(configPath, "utf8"));
              const key = `${pluginName}@moss-bundled`;
              config.plugins = { ...(config.plugins as object), [key]: { enabled: true } };
              const temporary = path.join(managedHomePath, `temp-${randomUUID()}`);
              await writeFile(temporary, stringify(config));
              try {
                await rename(temporary, configPath);
              } catch (error) {
                expect(["EPERM", "EACCES"]).toContain((error as NodeJS.ErrnoException).code);
                if (!permanent) await held.close();
                throw nativeError;
              } finally {
                await rm(temporary, { force: true });
              }
            },
            isInstalledAndEnabled: async () => true,
          }),
      });
      try {
        if (permanent) {
          await expect(boot).rejects.toBe(nativeError);
          expect(attempts).toEqual(Array(6).fill("moss-imagegen"));
          await expect(
            readFile(path.join(managedHomePath, ".moss-imagegen-bootstrap-v1")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          await boot;
          expect(attempts).toEqual([
            "moss-imagegen",
            "moss-imagegen",
            "moss-plugin-creator",
            "moss-videogen",
            "moss-canvas",
          ]);
          const config = parse(await readFile(configPath, "utf8"));
          expect(config.model).toBe("kept");
          for (const plugin of new Set(attempts)) {
            expect(config.plugins).toHaveProperty([`${plugin}@moss-bundled`, "enabled"], true);
            await expect(
              readFile(path.join(managedHomePath, `.${plugin}-bootstrap-v1`), "utf8"),
            ).resolves.toMatch(/-v1\n$/);
          }
        }
      } finally {
        await held.close();
      }
    },
  );

  it("treats Windows locks on a fresh plugin's files as transient", () => {
    for (const message of [
      "plugin/install failed: failed to persist installed plugin config: Access is denied. (os error 5)",
      "plugin/install failed: failed to install plugin: failed to activate plugin cache entry: 拒绝访问。 (os error 5)",
      "plugin/install failed: failed to install plugin: failed to activate plugin cache entry: The process cannot access the file because it is being used by another process. (os error 32)",
    ]) {
      expect(isTransientWindowsPluginInstallError(new Error(message))).toBe(true);
    }
    for (const message of [
      "plugin/install failed: failed to install plugin: plugin not found in marketplace",
      "plugin/install failed: failed to activate plugin cache entry: (os error 2)",
    ]) {
      expect(isTransientWindowsPluginInstallError(new Error(message))).toBe(false);
    }
  });

  it.runIf(process.platform === "win32")(
    "installs again while Windows still holds a just-copied plugin's cache entry",
    async () => {
      const { managedHomePath, configPath } = await setup("model = 'kept'\n");
      let attempts = 0;
      await installMossBundledPlugin({
        runtimeHomePath: managedHomePath,
        pluginName: "moss-imagegen",
        assertCurrent() {},
        install: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error(
              "plugin/install failed: failed to install plugin: failed to activate plugin cache entry: 拒绝访问。 (os error 5)",
            );
          }
          const config = parse(await readFile(configPath, "utf8"));
          config.plugins = { "moss-imagegen@moss-bundled": { enabled: true } };
          await writeFile(configPath, stringify(config));
        },
        isInstalledAndEnabled: async () => attempts >= 3,
      });
      expect(attempts).toBe(3);
    },
  );

  it.runIf(process.platform === "win32")(
    "verifies durable native state before accepting an ambiguous install",
    async () => {
      const { managedHomePath } = await setup(
        '[plugins."moss-imagegen@moss-bundled"]\nenabled=true\n',
      );
      let attempts = 0;
      let checks = 0;
      await installMossBundledPlugin({
        runtimeHomePath: managedHomePath,
        pluginName: "moss-imagegen",
        assertCurrent() {},
        install: async () => {
          attempts++;
          throw new Error(
            "plugin/install failed: failed to persist installed plugin config: 拒绝访问。 (os error 5)",
          );
        },
        isInstalledAndEnabled: async () => {
          checks++;
          return true;
        },
      });
      expect([attempts, checks]).toEqual([1, 1]);
    },
  );

  it.runIf(process.platform === "win32").each([false, true])(
    "only reads back while an exclusive config handle prevents inspection (permanent=%s)",
    async (permanent) => {
      const { managedHomePath, configPath } = await setup(
        '[plugins."moss-imagegen@moss-bundled"]\nenabled=true\n',
      );
      const systemRoot = process.env.SystemRoot!;
      const holder = spawn(
        path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$h=[IO.File]::Open($env:MOSS_TEST_CONFIG,'Open','Read','None');" +
            "[Console]::WriteLine('held');[void][Console]::ReadLine();$h.Dispose()",
        ],
        { windowsHide: true, env: { SystemRoot: systemRoot, MOSS_TEST_CONFIG: configPath } },
      );
      const closed = once(holder, "close");
      const nativeError = new Error(
        "plugin/install failed: failed to persist installed plugin config: Access is denied. (os error 5)",
      );
      let attempts = 0;
      let checks = 0;
      let releaseTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const [ready] = await Promise.race([
          once(holder.stdout, "data"),
          closed.then(() => {
            throw new Error("Config holder exited before taking the lock");
          }),
        ]);
        expect(String(ready).trim()).toBe("held");
        const install = installMossBundledPlugin({
          runtimeHomePath: managedHomePath,
          pluginName: "moss-imagegen",
          assertCurrent() {},
          install: async () => {
            attempts++;
            if (!permanent) releaseTimer = setTimeout(() => holder.stdin.end("\n"), 150);
            throw nativeError;
          },
          isInstalledAndEnabled: async () => {
            checks++;
            return true;
          },
        });
        if (permanent) await expect(install).rejects.toBe(nativeError);
        else await install;
        expect(attempts).toBe(1);
        expect(checks).toBe(permanent ? 0 : 1);
      } finally {
        clearTimeout(releaseTimer);
        if (!holder.stdin.writableEnded) holder.stdin.end("\n");
        await closed;
      }
    },
  );
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

  it("leaves the server-owned plugin catalog marketplace to the generated config", async () => {
    const source = await setup(
      `model_provider = "moss"
[marketplaces.moss-bundled]
source_type = "local"
source = "/owned/bundled"
[marketplaces.moss-catalog]
source_type = "local"
source = "/owned/catalog"
[plugins."superpowers@moss-catalog"]
enabled = true
`,
    );
    // A regenerated config writes both Moss marketplaces again; preserving them
    // too would declare the same table twice.
    const preserved = await readMossManagedPluginConfig(source);
    expect(parse(preserved)).toEqual({
      plugins: { "superpowers@moss-catalog": { enabled: true } },
    });
    const runtime = await setup(
      `[marketplaces.moss-catalog]
source_type = "local"
source = "/runtime/catalog"
[plugins."superpowers@moss-catalog"]
enabled = false
`,
    );
    await syncMossManagedPluginConfig({
      managedHomePath: source.managedHomePath,
      runtimeHomePath: runtime.managedHomePath,
      assertCurrent: () => undefined,
    });
    expect(parse(await readFile(source.configPath, "utf8"))).toEqual({
      model_provider: "moss",
      marketplaces: {
        "moss-bundled": { source_type: "local", source: "/owned/bundled" },
        "moss-catalog": { source_type: "local", source: "/owned/catalog" },
      },
      plugins: { "superpowers@moss-catalog": { enabled: false } },
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
