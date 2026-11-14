// FILE: apps/server/src/account/mossManagedHomeRecovery.test.ts
// Purpose: Verify offline recovery without real accounts or session refreshes.
// Layer: Server tests.
// Exports: None.
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@moss/contracts";
import { recoverManagedHome } from "./mossManagedHomeRecovery.ts";
import {
  buildMossManagedHomeOwnershipMarker,
  readManagedCodexHomeAuthority,
} from "./mossManagedHomeAuthority.ts";
import { buildMossManagedRelayInstances } from "./managedRelayProviders.ts";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../config.ts";
import {
  ServerSettingsLive,
  ServerSettingsService,
  providerEnvironmentSecretName,
} from "../serverSettings.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import {
  MossManagedProviderLive,
  buildMossManagedClaudeInstance,
} from "./Layers/MossManagedProvider.ts";
import { buildMossManagedOpenCodeProviderInstance } from "../provider/mossManagedOpenCodeEnvironment.ts";
import { buildMossManagedPiProviderInstance } from "../provider/mossManagedPiEnvironment.ts";
import { withManagedCleanupState } from "./Layers/MossManagedProvider.ts";
import { makeMossPhoneAccountService } from "./Layers/MossPhoneAccountService.ts";
import { createMemFirePhoneAuth } from "./supabaseMossAuth.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = [];
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const gateway = "https://api.mossbotai.com/functions/v1/moss-model-gateway/v1";
const env = { MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: gateway };
const pendingLogout = JSON.stringify({
  version: 1,
  generation: "fake-logout-generation",
  requestedAt: 1,
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(relays = false, unusedHomes = false) {
  const root = await fs.mkdtemp(
    path.join(process.env.MOSS_RECOVERY_TEST_TMP ?? os.tmpdir(), "managed-recovery-"),
  );
  roots.push(root);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const nonce = randomUUID();
  const homePath = path.join(source, "moss-codex-home");
  const settings: ServerSettings = {
    ...structuredClone(DEFAULT_SERVER_SETTINGS),
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        accounts: [{ id: "moss", label: "Moss", homePath, shadowHomePath: "" }],
      },
    },
    providerInstances: {
      codex_moss: {
        driver: "codex",
        enabled: true,
        environment: [{ name: "OPENAI_API_KEY", value: "fake-test-only", sensitive: true }],
        config: {
          managed: true,
          accountId: "moss",
          homePath,
          homeOwnershipNonce: nonce,
          runtimeGeneration: "fake-generation",
          gatewayBaseUrl: gateway,
          credentialEnvKey: "OPENAI_API_KEY",
        },
      },
      ...(relays
        ? {
            claude_moss: buildMossManagedClaudeInstance({
              accessToken: "fake-test-only",
              gatewayBaseUrl: gateway,
              runtimeGeneration: "fake-generation",
              realm: "cn",
              env,
            }),
            opencode_moss: buildMossManagedOpenCodeProviderInstance({
              accessToken: "fake-test-only",
              gatewayBaseUrl: gateway,
              runtimeGeneration: "fake-generation",
              env,
            }),
            pi_moss: buildMossManagedPiProviderInstance({
              accessToken: "fake-test-only",
              gatewayBaseUrl: gateway,
              runtimeGeneration: "fake-generation",
              realm: "cn",
              agentDir: path.join(source, "provider-homes", "pi", "cn"),
              env,
            }),
            ...buildMossManagedRelayInstances({
              stateDir: source,
              accessToken: "fake-test-only",
              gatewayBaseUrl: gateway,
              runtimeGeneration: "fake-generation",
              realm: "cn",
              env,
            }),
          }
        : {}),
    },
  };
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(source, "secrets"));
  await fs.mkdir(homePath);
  await fs.writeFile(
    path.join(homePath, ".moss-managed-home"),
    buildMossManagedHomeOwnershipMarker(nonce),
  );
  if (relays)
    for (const [id, instance] of Object.entries(settings.providerInstances)) {
      if (unusedHomes && ["hermes_moss", "kimi_moss", "minimax_moss", "zcode_moss"].includes(id))
        continue;
      const config = instance.config as Record<string, unknown>;
      for (const key of ["homePath", "agentDir"])
        if (typeof config[key] === "string")
          await fs.mkdir(config[key] as string, { recursive: true });
    }
  for (const [id, value] of Object.entries(settings.providerInstances)) {
    const instance = value as Mutable<typeof value>;
    instance.environment = await Promise.all(
      (instance.environment ?? []).map(async (entry) => {
        if (!entry.sensitive) return entry;
        const reference = providerEnvironmentSecretName({ instanceId: id, name: entry.name });
        await fs.writeFile(path.join(source, "secrets", `${reference}.bin`), "fake-test-only");
        return { ...entry, value: "", valueRedacted: true, valueSecretRef: reference };
      }),
    );
  }
  const settingsPath = (base: string) => path.join(base, "settings.json");
  await fs.writeFile(
    settingsPath(source),
    JSON.stringify({ revision: 7, migrationVersion: 1, settings }),
  );
  await fs.writeFile(
    path.join(source, "secrets", "moss.managed.binding.bin"),
    JSON.stringify({
      version: 1,
      state: "active",
      authority: "memfire-phone",
      bindingId: randomUUID(),
      accessTokenHash: createHash("sha256").update("fake-test-only").digest("hex"),
    }),
  );
  await fs.cp(source, target, { recursive: true });
  await fs.writeFile(path.join(target, "secrets", "moss.phone.logout_pending.bin"), pendingLogout);
  await fs.writeFile(path.join(target, "secrets", "fake-fence.bin"), "preserve-fake-fence");
  const read = async (base = target) => JSON.parse(await fs.readFile(settingsPath(base), "utf8"));
  const mutate = async (fn: (settings: Mutable<ServerSettings>) => void, base = target) => {
    const value = await read(base);
    fn(value.settings);
    await fs.writeFile(settingsPath(base), JSON.stringify(value));
  };
  const run = (applyPlan?: string) =>
    recoverManagedHome({ source, target, env, ...(applyPlan ? { applyPlan } : {}) });
  return { root, source, target, settingsPath, read, mutate, run };
}

describe("explicit offline managed-home recovery", () => {
  it("runs the real CLI in dry-run mode without writing settings", async () => {
    const f = await fixture();
    const before = await fs.readFile(f.settingsPath(f.target));
    const publicConfig = path.join(f.root, "public-config.json");
    await fs.writeFile(
      publicConfig,
      JSON.stringify({
        version: 2,
        authRealms: {
          "memfire-phone": {
            authority: "memfire-phone",
            region: "cn",
            authUrl: "https://moss-cn.baseapi.memfiredb.com",
            publishableKey: "memfire_publishable_test",
            modelGatewayUrl: gateway,
            realtimeRelayUrl: "https://realtime.moss.cn",
          },
          "supabase-google": {
            authority: "supabase-google",
            region: "global",
            authUrl: "https://moss-global.supabase.co",
            publishableKey: "sb_publishable_test",
            authRedirectUrl: "moss://auth/callback",
            modelGatewayUrl: "https://moss-global.supabase.co/functions/v1/moss-model-gateway/v1",
            realtimeRelayUrl: "https://realtime.moss.example",
          },
        },
      }),
    );
    const profileHome = path.join(f.root, "cli-profile", "home");
    const cliProfile = {
      HOME: profileHome,
      USERPROFILE: profileHome,
      APPDATA: path.join(profileHome, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(profileHome, "AppData", "Local"),
      MOSS_HOME: path.join(f.root, "cli-profile", "moss-home"),
      MOSS_DESKTOP_USER_DATA_DIR: path.join(f.root, "cli-profile", "moss-desktop"),
      CODEX_HOME: path.join(f.root, "cli-profile", "codex"),
      CODEX_SQLITE_HOME: path.join(f.root, "cli-profile", "codex-sqlite"),
      CLAUDE_CONFIG_DIR: path.join(f.root, "cli-profile", "claude"),
      XDG_CONFIG_HOME: path.join(f.root, "cli-profile", "xdg-config"),
      XDG_CACHE_HOME: path.join(f.root, "cli-profile", "xdg-cache"),
      BUN_INSTALL_CACHE_DIR: path.join(f.root, "cli-profile", "bun-cache"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(f.root, "cli-profile", "bun-transpiler"),
    };
    for (const directory of Object.values(cliProfile))
      await fs.mkdir(directory, { recursive: true });
    const { stdout } = await promisify(execFile)(
      "bun",
      [
        "--no-install",
        path.join(import.meta.dirname, "mossManagedHomeRecovery.ts"),
        "--source",
        f.source,
        "--target",
        f.target,
        "--public-config",
        publicConfig,
      ],
      {
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          SystemDrive: process.env.SystemDrive,
          ...cliProfile,
          TEMP: f.root,
          TMP: f.root,
          TMPDIR: f.root,
        },
      },
    );
    expect(JSON.parse(stdout).status).toBe("dry-run");
    expect(await fs.readFile(f.settingsPath(f.target))).toEqual(before);
  });
  it("defaults to dry-run, preserves all secret bytes and lets unmodified 1.0.5 authority validate the repaired home", async () => {
    const f = await fixture(true);
    const before = await fs.readFile(f.settingsPath(f.target));
    const secret = await fs.readFile(path.join(f.target, "secrets", "fake-fence.bin"));
    const preview = await f.run();
    expect(preview.status).toBe("dry-run");
    expect(await fs.readFile(f.settingsPath(f.target))).toEqual(before);
    expect((await f.run(preview.plan)).status).toBe("repaired");
    const { settings, revision } = await f.read();
    expect(revision).toBe(8);
    const original = (await f.read(f.source)).settings;
    for (const [id, instance] of Object.entries(settings.providerInstances)) {
      expect(
        (instance as ServerSettings["providerInstances"][string]).environment?.filter(
          (entry) => entry.sensitive,
        ),
      ).toEqual(
        original.providerInstances[id].environment?.filter(
          (entry: { sensitive?: boolean }) => entry.sensitive,
        ),
      );
    }
    expect(JSON.stringify(settings)).not.toContain(
      ["offline", "structural", "proof", "only"].join("-"),
    );
    expect(await fs.readFile(path.join(f.target, "secrets", "fake-fence.bin"))).toEqual(secret);
    const authority = await readManagedCodexHomeAuthority({
      stateDir: f.target,
      readSettings: async () => settings,
      readSettingsSync: () => settings,
      input: { accountId: "moss", homePath: path.join(f.target, "moss-codex-home"), env },
      platform: "win32",
    });
    await expect(authority!.assertCurrent()).resolves.toBeUndefined();
    const committed = await fs.readFile(f.settingsPath(f.target));
    expect((await f.run(preview.plan)).status).toBe("already-repaired");
    expect(await fs.readFile(f.settingsPath(f.target))).toEqual(committed);
  });
  it("accepts a proven generation with optional companions absent", async () => {
    const f = await fixture();
    expect((await f.run((await f.run()).plan)).status).toBe("repaired");
  });
  it("lets the unmodified installed-version provider finish its credential fence after repair", async () => {
    const f = await fixture(true, true);
    await f.mutate((s) => {
      for (const id of ["claude_moss", "opencode_moss"])
        s.providerInstances[id] = {
          ...withManagedCleanupState(s.providerInstances[id]!, "pending-v1"),
          enabled: false,
          environment: [],
        };
    });
    for (const id of ["claude_moss", "opencode_moss"]) {
      const before = await f.read(f.source);
      for (const entry of before.settings.providerInstances[id].environment)
        if (entry.sensitive)
          await fs.unlink(path.join(f.target, "secrets", `${entry.valueSecretRef}.bin`));
    }
    await f.run((await f.run()).plan);
    for (const root of [f.source, f.target])
      for (const driver of ["hermes", "kimi", "minimax", "zcode"]) {
        await expect(
          fs.lstat(path.join(root, "provider-homes", driver, "cn")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    const repaired = await f.read();
    for (const id of ["claude_moss", "opencode_moss"]) {
      expect(repaired.settings.providerInstances[id].enabled).toBe(false);
      expect(repaired.settings.providerInstances[id].environment).toEqual([]);
    }
    const originalEnv = process.env.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL;
    process.env.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL = gateway;
    const provider = {
      listSessions: () => Effect.succeed([]),
      fenceProviderInstanceLaunchesAndWait: () => Effect.void,
      stopCodexAccountRuntimes: () => Effect.void,
    } as unknown as ProviderServiceShape;
    const config = ServerConfig.layerTest(process.cwd(), f.root, {
      stateDir: f.target,
      settingsPath: f.settingsPath(f.target),
      secretsDir: path.join(f.target, "secrets"),
      dbPath: path.join(f.target, "state.sqlite"),
    }).pipe(Layer.provide(NodeServices.layer));
    const base = Layer.mergeAll(
      NodeServices.layer,
      config,
      Layer.succeed(ProviderService, provider),
    );
    const settings = ServerSettingsLive.pipe(Layer.provide(base));
    const dependencies = Layer.mergeAll(
      base,
      settings,
      ServerSecretStoreLive.pipe(Layer.provide(base)),
    );
    const layer = Layer.mergeAll(
      dependencies,
      MossManagedProviderLive.pipe(Layer.provide(dependencies)),
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ServerSettingsService;
            yield* service.start;
            const secretStore = yield* ServerSecretStore;
            const fetchImpl = vi.fn(async () => {
              throw new Error("Unexpected network request");
            }) as unknown as typeof fetch;
            const phone = yield* makeMossPhoneAccountService({
              auth: createMemFirePhoneAuth({ env: {}, fetchImpl }),
            });
            yield* phone.getSession();
            expect(fetchImpl).not.toHaveBeenCalled();
            const current = yield* service.getSettings;
            expect(current.providerInstances.codex_moss?.enabled).toBe(false);
            expect(current.providerInstances.codex_moss?.environment).toEqual([]);
            for (const id of Object.keys(repaired.settings.providerInstances)) {
              const instance = current.providerInstances[id];
              if (!instance) continue;
              expect(instance.enabled).toBe(false);
              expect(instance.environment).toEqual([]);
            }
            expect(yield* secretStore.get("moss.managed.binding")).toBeNull();
            expect(yield* secretStore.get("moss.phone.logout_pending")).toBeNull();
            expect(yield* secretStore.get("moss.phone.session")).toBeNull();
          }).pipe(Effect.provide(layer)),
        ),
      );
    } finally {
      if (originalEnv === undefined) delete process.env.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL;
      else process.env.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL = originalEnv;
    }
  });
  it("does not accept a copied target marker without a valid original reservation", async () => {
    const f = await fixture();
    await f.mutate((s) => {
      s.providerInstances.codex_moss!.config = { managed: true };
    }, f.source);
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects a foreign same-name companion without changing settings", async () => {
    const f = await fixture();
    await f.mutate((s) => {
      s.providerInstances.pi_moss = { driver: "pi", enabled: true, config: { managed: true } };
    });
    const before = await fs.readFile(f.settingsPath(f.target));
    await expect(f.run()).rejects.toThrow();
    expect(await fs.readFile(f.settingsPath(f.target))).toEqual(before);
  });
  it("rejects a different generation", async () => {
    const f = await fixture();
    await f.mutate((s) => {
      (s.providerInstances.codex_moss!.config as Record<string, unknown>).runtimeGeneration =
        "foreign";
    });
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects a cleanup-shaped change outside the two supported companion tombstones", async () => {
    const f = await fixture(true);
    await f.mutate((s) => {
      s.providerInstances.pi_moss = {
        ...withManagedCleanupState(s.providerInstances.pi_moss!, "pending-v1"),
        enabled: false,
        environment: [],
      };
    });
    await expect(f.run()).rejects.toThrow();
  });
  it("does not let a masked secret reference hide a missing credential file", async () => {
    const f = await fixture(true);
    for (const base of [f.source, f.target])
      await f.mutate((s) => {
        const instance = s.providerInstances.grok_moss!;
        instance.environment = instance.environment!.map((entry) =>
          entry.sensitive
            ? {
                ...entry,
                value: "",
                valueRedacted: true,
                valueSecretRef: providerEnvironmentSecretName({
                  instanceId: "absent-instance",
                  name: entry.name,
                }),
              }
            : entry,
        );
      }, base);
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects retargeting a legacy reference to another existing same-value file", async () => {
    const f = await fixture(true);
    await f.mutate((s) => {
      const other = s.providerInstances.codex_moss!.environment![0]!.valueSecretRef;
      s.providerInstances.grok_moss!.environment = s.providerInstances.grok_moss!.environment!.map(
        (entry) => (entry.sensitive ? { ...entry, valueSecretRef: other! } : entry),
      );
    });
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects a hard-linked ownership marker", async () => {
    const f = await fixture();
    const marker = path.join(f.target, "moss-codex-home", ".moss-managed-home");
    await fs.unlink(marker);
    await fs.link(path.join(f.source, "moss-codex-home", ".moss-managed-home"), marker);
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects a secret-set change after dry-run", async () => {
    const f = await fixture();
    const plan = (await f.run()).plan;
    await fs.writeFile(path.join(f.target, "secrets", "fake-fence.bin"), "new-fence");
    await expect(f.run(plan)).rejects.toThrow();
    expect((await f.read()).revision).toBe(7);
  });
  it("rejects a foreign home beneath the reserved home", async () => {
    const f = await fixture();
    await f.mutate((s) => {
      s.providerInstances.foreign = {
        driver: "codex",
        config: { homePath: path.join(f.target, "moss-codex-home", "child") },
      };
    });
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects a live application lifecycle lock without touching its owner", async () => {
    const f = await fixture();
    const lock = path.join(f.target, "state.sqlite.lifecycle-lock");
    await fs.mkdir(lock);
    const owner = JSON.stringify({
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    await fs.writeFile(path.join(lock, "owner.json"), owner);
    await expect(f.run()).rejects.toThrow();
    expect(await fs.readFile(path.join(lock, "owner.json"), "utf8")).toBe(owner);
  });
  it("rejects a mismatched binding and preserves logout tombstone", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.target, "secrets", "moss.managed.binding.bin"),
      "different-binding",
    );
    await expect(f.run()).rejects.toThrow();
    expect(
      await fs.readFile(path.join(f.target, "secrets", "moss.phone.logout_pending.bin"), "utf8"),
    ).toBe(pendingLogout);
  });
  it("refuses to restore or replay a stored phone session", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.target, "secrets", "moss.phone.session.bin"), "fake-session");
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects stale reviewed plans after concurrent settings edits", async () => {
    const f = await fixture();
    const plan = (await f.run()).plan;
    await f.mutate((s) => {
      s.providerInstances.extra = { driver: "codex", enabled: false };
    });
    const before = await fs.readFile(f.settingsPath(f.target));
    await expect(f.run(plan)).rejects.toThrow();
    expect(await fs.readFile(f.settingsPath(f.target))).toEqual(before);
  });
  it("allows only one concurrent commit", async () => {
    const f = await fixture();
    const plan = (await f.run()).plan;
    const results = await Promise.allSettled([f.run(plan), f.run(plan)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await f.read()).revision).toBe(8);
  });
  it("rejects a junction root", async () => {
    const f = await fixture();
    const alias = path.join(f.root, "alias");
    await fs.symlink(f.target, alias, "junction");
    await expect(recoverManagedHome({ source: f.source, target: alias, env })).rejects.toThrow();
  });
  it("rejects creation of a previously absent relay path after review", async () => {
    const f = await fixture(true, true);
    const plan = (await f.run()).plan;
    await fs.mkdir(path.join(f.target, "provider-homes", "hermes", "cn"), { recursive: true });
    await expect(f.run(plan)).rejects.toMatchObject({
      stage: "home-identities",
      reason: "proof-mismatch",
    });
    expect((await f.read()).revision).toBe(7);
  });
  it("rejects redirecting the missing chain after review", async () => {
    const f = await fixture(true, true);
    const plan = (await f.run()).plan;
    const other = path.join(f.root, "foreign");
    await fs.mkdir(path.join(other, "cn"), { recursive: true });
    await fs.symlink(other, path.join(f.target, "provider-homes", "hermes"), "junction");
    await expect(f.run(plan)).rejects.toMatchObject({
      stage: "target-validation",
      reason: "proof-mismatch",
    });
    expect((await f.read()).revision).toBe(7);
  });
  it("rejects replacing the real nearest ancestor even when the missing tail is unchanged", async () => {
    const f = await fixture(true, true);
    const plan = (await f.run()).plan;
    const parent = path.join(f.source, "provider-homes");
    const retained = path.join(f.source, "provider-homes.previous");
    await fs.rename(parent, retained);
    await fs.cp(retained, parent, { recursive: true });
    await expect(f.run(plan)).rejects.toMatchObject({
      stage: "reviewed-plan",
      reason: "proof-mismatch",
    });
    expect((await f.read()).revision).toBe(7);
  });
  it("reports only fixed safe stage and reason fields", async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.source, "moss-codex-home", ".moss-managed-home"));
    await expect(f.run()).rejects.toMatchObject({
      stage: "source-validation",
      reason: "path-missing",
      message: "Managed recovery was refused.",
    });
  });
  it("rejects intersecting roots", async () => {
    const f = await fixture();
    await expect(
      recoverManagedHome({ source: f.source, target: path.join(f.source, "moss-codex-home"), env }),
    ).rejects.toThrow();
  });
  it("fails atomically and can retry after an interrupted rename", async () => {
    const f = await fixture();
    const plan = (await f.run()).plan;
    const before = await fs.readFile(f.settingsPath(f.target));
    const rename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"))
      .rename;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).includes(".managed-recovery-"))
        throw new Error("simulated crash before commit");
      return rename(from, to);
    });
    await expect(f.run(plan)).rejects.toThrow();
    expect(await fs.readFile(f.settingsPath(f.target))).toEqual(before);
    spy.mockRestore();
    expect((await f.run(plan)).status).toBe("repaired");
  });
  it("reports an unknown commit outcome and safely retries after a lost commit acknowledgement", async () => {
    const f = await fixture();
    const plan = (await f.run()).plan;
    const rename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"))
      .rename;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(from).includes(".managed-recovery-"))
        throw new Error("simulated acknowledgement loss");
    });
    await expect(f.run(plan)).rejects.toMatchObject({
      stage: "commit",
      reason: "commit-state-unknown",
    });
    spy.mockRestore();
    expect((await f.read()).revision).toBe(8);
    expect((await f.run(plan)).status).toBe("already-repaired");
    expect((await f.read()).revision).toBe(8);
  });
});
