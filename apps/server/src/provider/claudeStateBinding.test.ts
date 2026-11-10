import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Schema } from "effect";
import { ServerSettings } from "@moss/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { buildMossManagedClaudeInstance } from "../account/Layers/MossManagedProvider.ts";
import { ServerConfig } from "../config.ts";
import { canonicalizeCodexHomeIdentityPath } from "../codexHomeIdentity.ts";
import { buildClaudeInstanceProcessEnv } from "./claudeEnvironment.ts";
import { makeAgentProgramOwnership } from "./agentProgramOwnership.ts";
import {
  prepareProviderContinuationIdentity,
  providerContinuationIdentity,
} from "./continuationIdentity.ts";
import {
  claudeStateBindingAccountFromSettings,
  claudeStateBindingReference,
  makeClaudeStateBindingAccess,
  makeClaudeStateBindingSelection,
  readClaudeStateBinding,
  type ClaudeStateBindingAccount,
} from "./claudeStateBinding.ts";

let root: string;
let stateDir: string;
let account: ClaudeStateBindingAccount;
const accounts = new Map<string, ClaudeStateBindingAccount>();
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "moss-claude-binding-"));
  stateDir = path.join(root, "server-state");
  account = {
    providerInstanceId: "claude_own",
    enabled: true,
    managed: false,
    sourceProjectsPath: path.join(root, "projects"),
    homePath: path.join(root, "private"),
    configPath: path.join(root, "private", ".claude"),
    runtimeGeneration: "own-generation-1",
    environment: { ANTHROPIC_API_KEY: "synthetic-own-key" },
  };
  for (const directory of [stateDir, account.sourceProjectsPath, account.configPath])
    mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(account.configPath, ".credentials.json"), '{"fixture":"own"}');
  writeFileSync(path.join(account.configPath, "settings.json"), '{"fixture":"private-settings"}');
  accounts.clear();
  accounts.set(account.providerInstanceId, account);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const change = (patch: Partial<ClaudeStateBindingAccount>) => {
  account = { ...account, ...patch };
  accounts.set(account.providerInstanceId, account);
};
const request = (reference: string, providerInstanceId = account.providerInstanceId) => ({
  reference,
  expectedReference: reference,
  providerInstanceId,
});
const makeAccess = (
  readAccount: (id: string) => ClaudeStateBindingAccount | undefined = (id) => accounts.get(id),
) =>
  Effect.runPromise(
    makeClaudeStateBindingAccess({
      stateDir,
      readAccount,
    }).pipe(
      Effect.provide(
        ServerSecretStoreLive.pipe(
          Layer.provide(
            ServerConfig.layerTest(root, path.join(root, "server"), {
              stateDir,
              secretsDir: path.join(stateDir, "secrets"),
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );

describe("server Claude shared projects receipts", () => {
  const managedFixture = async () => {
    const access = await makeAccess();
    const managed: ClaudeStateBindingAccount = {
      providerInstanceId: "claude_moss",
      enabled: true,
      managed: true,
      runtimeGeneration: "managed-generation-1",
      sourceProjectsPath: account.sourceProjectsPath,
      homePath: "",
      configPath: "",
      environment: {
        ANTHROPIC_AUTH_TOKEN: "synthetic-managed-key",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        ENABLE_TOOL_SEARCH: "true",
      },
    };
    accounts.set(managed.providerInstanceId, managed);
    const binding = await access.register(managed.providerInstanceId);
    const record = readClaudeStateBinding(binding.options)!.record;
    const clear = (assertPrivateIdle: (path: string) => void = () => {}) =>
      access.clearManagedPrivateState({
        providerInstanceId: managed.providerInstanceId,
        assertAccountDisabled: () => {
          if (accounts.get(managed.providerInstanceId)?.enabled)
            throw new Error("fixture account still enabled");
        },
        assertPrivateIdle,
      });
    return { access, managed, binding, record, clear };
  };

  it("clears only stopped managed private contents and renews old bindings with root inodes retained", async () => {
    const { access, managed, binding, record, clear } = await managedFixture();
    await access.register(account.providerInstanceId);
    writeFileSync(path.join(record.private.path, ".credentials.json"), "managed-private-fixture");
    writeFileSync(path.join(record.home.path, "settings.json"), "managed-settings");
    mkdirSync(path.join(record.private.path, "cache"));
    writeFileSync(path.join(record.private.path, "cache", "cached.json"), "managed-cache");
    writeFileSync(
      path.join(account.sourceProjectsPath, "native-history.jsonl"),
      "preserved-native-history",
    );
    const binaryPath = path.join(root, "fixture-cli");
    writeFileSync(binaryPath, "fixture-program");
    const programs = makeAgentProgramOwnership("claudeAgent");
    const own = programs.spawn({
      binaryPath,
      sourceHomePath: account.configPath,
      spawn: () => new EventEmitter(),
    });
    const moss = programs.spawn({
      binaryPath,
      sourceHomePath: record.private.path,
      spawn: () => new EventEmitter(),
    });
    accounts.set(managed.providerInstanceId, { ...managed, enabled: false, environment: {} });
    const clean = () => clear((privatePath) => programs.assertPrivateSourceIdle(privatePath));
    await expect(clean()).rejects.toThrow(/尚未结束/);
    moss.emit("exit", 0);
    await expect(clean()).rejects.toThrow(/尚未结束/);
    expect(readFileSync(path.join(record.private.path, ".credentials.json"), "utf8")).toBe(
      "managed-private-fixture",
    );
    moss.emit("close", 0);
    await clean();
    await clean();
    expect(lstatSync(record.home.path, { bigint: true }).ino.toString()).toBe(record.home.inode);
    expect(lstatSync(record.private.path, { bigint: true }).ino.toString()).toBe(
      record.private.inode,
    );
    expect(readdirSync(record.home.path)).toEqual([".claude"]);
    expect(readdirSync(record.private.path)).toEqual(["projects"]);
    expect(
      readFileSync(path.join(account.sourceProjectsPath, "native-history.jsonl"), "utf8"),
    ).toBe("preserved-native-history");
    expect(readFileSync(path.join(account.configPath, ".credentials.json"), "utf8")).toBe(
      '{"fixture":"own"}',
    );
    expect(() => programs.assertPrivateSourceIdle(account.configPath)).toThrow(/尚未结束/);
    accounts.set(managed.providerInstanceId, {
      ...managed,
      runtimeGeneration: "managed-generation-2",
      sourceProjectsPath: path.join(root, "changed-global-source"),
    });
    const renewed = (await access.rebind(request(binding.reference, managed.providerInstanceId)))!;
    expect(renewed.reference).not.toBe(binding.reference);
    expect(renewed.sourceGeneration).toBe(binding.sourceGeneration);
    expect(renewed.options.homePath).toBe(binding.options.homePath);
    expect(readClaudeStateBinding(renewed.options)!.record.private.inode).toBe(
      record.private.inode,
    );
    expect(
      access.restoreStop(request(binding.reference, managed.providerInstanceId))?.reference,
    ).toBe(binding.reference);
    own.emit("close", 0);
  });

  it("rejects unknown nested junctions and replaced private roots before removing content", async () => {
    const { managed, record, clear } = await managedFixture();
    accounts.set(managed.providerInstanceId, { ...managed, enabled: false });
    const marker = path.join(record.private.path, ".credentials.json");
    writeFileSync(marker, "preserved-private");
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "marker"), "preserved-outside");
    const link = path.join(record.private.path, "unknown-cache");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    await expect(clear()).rejects.toThrow(/未验证链接/);
    expect(readFileSync(marker, "utf8")).toBe("preserved-private");
    expect(readFileSync(path.join(outside, "marker"), "utf8")).toBe("preserved-outside");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    unlinkSync(link);
    const orphan = path.join(path.dirname(record.home.path), "unverified-home");
    mkdirSync(orphan);
    await expect(clear()).rejects.toThrow(/缺少已验证绑定/);
    expect(readFileSync(marker, "utf8")).toBe("preserved-private");
    rmdirSync(orphan);
    renameSync(record.private.path, path.join(record.home.path, "retained-private"));
    mkdirSync(record.private.path);
    writeFileSync(marker, "replacement-preserved");
    await expect(clear()).rejects.toThrow(/替换/);
    expect(readFileSync(marker, "utf8")).toBe("replacement-preserved");
    expect(existsSync(path.join(record.home.path, "retained-private", ".credentials.json"))).toBe(
      true,
    );
  });

  it("preserves private state when the account restarts during asynchronous cleanup preflight", async () => {
    const { managed, record, clear } = await managedFixture();
    const marker = path.join(record.private.path, ".credentials.json");
    writeFileSync(marker, "keep me");
    accounts.set(managed.providerInstanceId, { ...managed, enabled: false });
    const clearing = clear();
    accounts.set(managed.providerInstanceId, managed);
    await expect(clearing).rejects.toThrow();
    expect(readFileSync(marker, "utf8")).toBe("keep me");
  });

  it("rejects an aliased managed ancestor and preserves the outside directory", async () => {
    const { managed, record, clear } = await managedFixture();
    accounts.set(managed.providerInstanceId, { ...managed, enabled: false });
    const ancestor = path.dirname(record.home.path);
    const retained = `${ancestor}-retained`;
    renameSync(ancestor, retained);
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "marker"), "preserved");
    symlinkSync(outside, ancestor, process.platform === "win32" ? "junction" : "dir");
    await expect(clear()).rejects.toThrow();
    expect(readdirSync(outside)).toEqual(["marker"]);
    expect(readFileSync(path.join(outside, "marker"), "utf8")).toBe("preserved");
    expect(
      existsSync(path.join(retained, path.basename(record.home.path), ".claude", "projects")),
    ).toBe(true);
  });

  it("keeps an explicitly selected existing projects directory in place", async () => {
    const projects = path.join(account.configPath, "projects");
    mkdirSync(projects);
    writeFileSync(path.join(projects, "original.jsonl"), "original history");
    change({ sourceProjectsPath: projects });
    const before = lstatSync(projects, { bigint: true });
    const access = await makeAccess();
    const binding = await access.register(account.providerInstanceId);
    expect(lstatSync(projects).isSymbolicLink()).toBe(false);
    expect(lstatSync(projects, { bigint: true }).ino).toBe(before.ino);
    expect(readFileSync(path.join(projects, "original.jsonl"), "utf8")).toBe("original history");
    expect(readClaudeStateBinding(binding.options)?.record.source.path).toBe(
      canonicalizeCodexHomeIdentityPath(projects),
    );
  });

  it("preserves a different nonempty projects root and refuses to replace it", async () => {
    const projects = path.join(account.configPath, "projects");
    mkdirSync(projects);
    writeFileSync(path.join(projects, "original.jsonl"), "original history");
    const access = await makeAccess();
    await expect(access.register(account.providerInstanceId)).rejects.toThrow(/已有其他历史/);
    expect(lstatSync(projects).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(projects, "original.jsonl"), "utf8")).toBe("original history");
  });

  it("rebinds to a separate generated managed home with the exact selected credential environment", async () => {
    const access = await makeAccess();
    const original = await access.register(account.providerInstanceId);
    const own = request(original.reference);
    const managed: ClaudeStateBindingAccount = {
      providerInstanceId: "claude_moss",
      enabled: true,
      managed: true,
      runtimeGeneration: "moss-generation-1",
      sourceProjectsPath: path.join(root, "changed-global-projects"),
      homePath: "",
      configPath: "",
      environment: {
        ANTHROPIC_AUTH_TOKEN: "synthetic-managed-key",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        ENABLE_TOOL_SEARCH: "true",
      },
    };
    accounts.set(managed.providerInstanceId, managed);
    const shared = (await access.rebind(own, managed.providerInstanceId))!;
    expect(shared.sourceGeneration).toBe(original.sourceGeneration);
    expect(providerContinuationIdentity("claudeAgent", { claudeAgent: shared.options })).toBe(
      providerContinuationIdentity("claudeAgent", { claudeAgent: original.options }),
    );
    expect(shared.options.homePath).not.toBe(original.options.homePath);
    expect(shared.options.environment).toEqual(managed.environment);
    expect(shared.options.environment).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    const env = buildClaudeInstanceProcessEnv(shared.options.homePath, shared.options.environment, {
      baseEnvironment: { CLAUDE_CONFIG_DIR: "ignored-ambient" },
      providerInstanceId: managed.providerInstanceId,
    });
    expect(env.HOME).toBe(shared.options.homePath);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    const linkedProjects = realpathSync(path.join(shared.options.homePath!, ".claude", "projects"));
    expect(canonicalizeCodexHomeIdentityPath(linkedProjects)).toBe(
      canonicalizeCodexHomeIdentityPath(account.sourceProjectsPath),
    );
    expect(lstatSync(linkedProjects, { bigint: true }).ino).toBe(
      lstatSync(account.sourceProjectsPath, { bigint: true }).ino,
    );
    expect(readFileSync(path.join(account.configPath, ".credentials.json"), "utf8")).toBe(
      '{"fixture":"own"}',
    );
    expect(access.restoreStop(own)?.reference).toBe(original.reference);
    accounts.set("claude_impostor", {
      ...account,
      providerInstanceId: "claude_impostor",
      homePath: shared.options.homePath!,
      configPath: path.join(shared.options.homePath!, ".claude"),
    });
    await expect(access.register("claude_impostor")).rejects.toThrow(/Moss 管理目录/);
    const ancestor = path.join(stateDir, "provider-homes");
    for (const role of ["home", "config", "secure"]) {
      const providerInstanceId = `claude_ancestor_${role}`;
      accounts.set(providerInstanceId, {
        ...account,
        providerInstanceId,
        ...(role === "home" ? { homePath: ancestor } : {}),
        ...(role === "config" ? { configPath: ancestor } : {}),
        ...(role === "secure"
          ? { environment: { ...account.environment, CLAUDE_SECURESTORAGE_CONFIG_DIR: ancestor } }
          : {}),
      });
      await expect(access.register(providerInstanceId)).rejects.toThrow(/Moss 管理目录/);
    }
  });

  it("keeps old source bindings through restart, disabled stop and current global changes", async () => {
    const access = await makeAccess();
    const original = await access.register(account.providerInstanceId);
    const source = account.sourceProjectsPath;
    change({ sourceProjectsPath: path.join(root, "different-global-projects") });
    const restarted = await makeAccess();
    const restored = restarted.restoreLaunch(request(original.reference))!;
    expect(readClaudeStateBinding(restored.options)?.record.source.path).toBe(
      canonicalizeCodexHomeIdentityPath(source),
    );
    change({ enabled: false });
    expect(() => restarted.restoreLaunch(request(original.reference))).toThrow(/停用/);
    await expect(restarted.rebind(request(original.reference))).rejects.toThrow(/停用/);
    expect(() => readClaudeStateBinding(original.options)).toThrow(/停用/);
    expect(claudeStateBindingReference(original.options)).toBe(original.reference);
    expect(restarted.restoreStop(request(original.reference))?.reference).toBe(original.reference);
  });

  it("rejects forged capabilities, another provider, changed options and cross-account references", async () => {
    const access = await makeAccess();
    const original = await access.register(account.providerInstanceId);
    expect(() => readClaudeStateBinding(JSON.parse(JSON.stringify(original.options)))).toThrow(
      /绑定无效/,
    );
    expect(() =>
      readClaudeStateBinding({ ...original.options, stateBinding: { provider: "codex" } as never }),
    ).toThrow(/绑定无效/);
    expect(() => readClaudeStateBinding({ ...original.options, homePath: root })).toThrow(/不一致/);
    expect(() =>
      readClaudeStateBinding({
        ...original.options,
        environment: { ...original.options.environment, ANTHROPIC_API_KEY: "different-fixture" },
      }),
    ).toThrow(/不一致/);
    expect(() => access.restoreLaunch(request(original.reference, "claude_other"))).toThrow(
      /不属于/,
    );
    expect(() =>
      access.restoreLaunch({ ...request(original.reference), expectedReference: "other" }),
    ).toThrow(/不一致/);
    accounts.set("claude_other", { ...account, providerInstanceId: "claude_other" });
    await expect(access.rebind(request(original.reference), "claude_other")).rejects.toThrow(
      /不能共用/,
    );
  });

  it.each(["source", "private", "home"] as const)(
    "rejects a replaced %s identity without rebuilding the old source",
    async (target) => {
      const access = await makeAccess();
      const original = await access.register(account.providerInstanceId);
      const directory =
        target === "source"
          ? account.sourceProjectsPath
          : target === "private"
            ? account.configPath
            : account.homePath;
      renameSync(directory, path.join(root, "retained-original"));
      mkdirSync(directory);
      expect(() => access.restoreLaunch(request(original.reference))).toThrow();
      expect(readClaudeStateBinding(original.options, false)?.reference).toBe(original.reference);
      expect(access.restoreStop(request(original.reference))?.reference).toBe(original.reference);
    },
  );

  it("renews credential generation while retaining source and old stop ownership", async () => {
    // Even an accidentally forwarded non-managed field cannot bypass the
    // ordinary account's credential-derived generation.
    change({ runtimeGeneration: "ignored-own-server-generation" });
    const access = await makeAccess();
    const original = await access.register(account.providerInstanceId);
    const auth = path.join(account.configPath, ".credentials.json");
    renameSync(auth, path.join(account.configPath, "retained-auth"));
    writeFileSync(auth, '{"fixture":"own"}');
    expect(() => access.restoreLaunch(request(original.reference))).toThrow(/绑定已更换/);
    const renewed = (await access.rebind(request(original.reference)))!;
    expect(renewed.reference).not.toBe(original.reference);
    expect(renewed.sourceGeneration).toBe(original.sourceGeneration);
    expect(access.restoreStop(request(original.reference))?.reference).toBe(original.reference);
    expect(claudeStateBindingReference(original.options)).toBe(original.reference);
    expect(readClaudeStateBinding(renewed.options)).toBeDefined();
  });

  it("rejects private directories as shared history before creating a projects link", async () => {
    change({ sourceProjectsPath: account.homePath });
    const access = await makeAccess();
    await expect(access.register(account.providerInstanceId)).rejects.toThrow(
      /私有账户|配置或凭据/,
    );
    expect(() => lstatSync(path.join(account.configPath, "projects"))).toThrow();
  });

  it("rejects a new binding if current global source changes during selection", async () => {
    const nextSource = path.join(root, "next-projects");
    mkdirSync(nextSource);
    let firstRead = true;
    const access = await makeAccess(() => {
      if (firstRead) {
        firstRead = false;
        return account;
      }
      return { ...account, sourceProjectsPath: nextSource };
    });
    await expect(access.register(account.providerInstanceId)).rejects.toThrow(
      /设置在绑定时发生变化/,
    );
    expect(() => lstatSync(path.join(account.configPath, "projects"))).toThrow();
  });

  it("restores stop ownership after private cleanup while refusing every new launch", async () => {
    const access = await makeAccess();
    const original = await access.register(account.providerInstanceId);
    change({ enabled: false });
    // Only the temporary private fixture root is removed; shared source stays.
    expect(account.configPath.startsWith(root + path.sep)).toBe(true);
    rmSync(account.configPath, { recursive: true });
    expect(access.restoreStop(request(original.reference))?.reference).toBe(original.reference);
    expect(claudeStateBindingReference(original.options)).toBe(original.reference);
    expect(readClaudeStateBinding(original.options, false)?.record.runtimeGeneration).toBeDefined();
    expect(
      providerContinuationIdentity("claudeAgent", { claudeAgent: original.options }),
    ).toContain("claudeAgent:shared-v1:");
    await expect(
      prepareProviderContinuationIdentity(
        "claudeAgent",
        { claudeAgent: original.options },
        undefined,
      ),
    ).rejects.toThrow();
    expect(() => readClaudeStateBinding(original.options)).toThrow();
    expect(() => access.restoreLaunch(request(original.reference))).toThrow();
    await expect(access.rebind(request(original.reference))).rejects.toThrow(/停用/);
    expect(lstatSync(account.sourceProjectsPath).isDirectory()).toBe(true);
  });
});

describe("server Claude account selection", () => {
  const settingsFor = (config: Record<string, unknown> = {}) =>
    Schema.decodeSync(ServerSettings)({
      providers: {
        claudeAgent: {
          shareStateAcrossAccounts: true,
          sharedProjectsPath: account.sourceProjectsPath,
        },
      },
      providerInstances: {
        claude_own: {
          driver: "claudeAgent",
          config: {
            homePath: account.homePath,
            configDir: account.configPath,
            runtimeGeneration: "untrusted-own-generation",
            ...config,
          },
          environment: [
            { name: "ANTHROPIC_API_KEY", value: "synthetic-selected-key", sensitive: true },
          ],
        },
      },
    });

  it("defaults sharing off and requires explicit private paths without consulting ambient HOME", () => {
    const defaults = Schema.decodeSync(ServerSettings)({});
    expect(defaults.providers.claudeAgent.shareStateAcrossAccounts).toBe(false);
    expect(defaults.providers.claudeAgent.sharedProjectsPath).toBe("");
    const selected = claudeStateBindingAccountFromSettings(settingsFor(), "claude_own")!;
    expect(selected.homePath).toBe(account.homePath);
    expect(selected.configPath).toBe(account.configPath);
    expect(selected.managed).toBe(false);
    expect(selected.runtimeGeneration).toBeUndefined();
    expect(() =>
      claudeStateBindingAccountFromSettings(settingsFor({ homePath: "" }), "claude_own"),
    ).toThrow(/私有 HOME/);
    expect(() =>
      claudeStateBindingAccountFromSettings(
        settingsFor({ homePath: "relative-home" }),
        "claude_own",
      ),
    ).toThrow(/绝对路径/);
  });

  it("rejects overlapping private roots for different configured accounts", () => {
    const initial = settingsFor();
    const settings = {
      ...initial,
      providerInstances: {
        ...initial.providerInstances,
        claude_other: {
          driver: "claudeAgent",
          enabled: false,
          config: { configDir: account.configPath },
        },
      },
    };
    expect(() => claudeStateBindingAccountFromSettings(settings, "claude_own")).toThrow(
      /独立 HOME/,
    );
  });

  it("accepts managed generation only after the existing exact server-instance verifier", () => {
    const gatewayBaseUrl = "https://project.supabase.co/functions/v1/moss-model-gateway/v1";
    const trustedEnv = { MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: gatewayBaseUrl };
    const managed = buildMossManagedClaudeInstance({
      accessToken: "synthetic-managed-token",
      gatewayBaseUrl,
      runtimeGeneration: "verified-managed-generation",
      env: trustedEnv,
      realm: "global",
    });
    const initial = settingsFor();
    const settings = {
      ...initial,
      providerInstances: { ...initial.providerInstances, claude_moss: managed },
    };
    const selected = claudeStateBindingAccountFromSettings(settings, "claude_moss", trustedEnv)!;
    expect(selected.managed).toBe(true);
    expect(selected.runtimeGeneration).toBe("verified-managed-generation");
    expect(Object.keys(selected.environment!)).toEqual([
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ENABLE_TOOL_SEARCH",
    ]);
    const invalid = {
      ...settings,
      providerInstances: {
        ...settings.providerInstances,
        claude_moss: {
          ...managed,
          environment: [
            ...managed.environment!,
            { name: "CLAUDE_CONFIG_DIR", value: account.configPath, sensitive: false },
          ],
        },
      },
    };
    expect(() => claudeStateBindingAccountFromSettings(invalid, "claude_moss", trustedEnv)).toThrow(
      /无法验证/,
    );
    expect(() =>
      claudeStateBindingAccountFromSettings(
        settingsFor({ managed: true }),
        "claude_own",
        trustedEnv,
      ),
    ).toThrow(/无法验证/);
  });

  it("selects a real server capability, removes caller credentials and rechecks disabled accounts", async () => {
    let settings = settingsFor();
    const select = await Effect.runPromise(
      makeClaudeStateBindingSelection({ stateDir, readSettings: () => settings }).pipe(
        Effect.provide(
          ServerSecretStoreLive.pipe(
            Layer.provide(
              ServerConfig.layerTest(root, path.join(root, "server"), {
                stateDir,
                secretsDir: path.join(stateDir, "secrets"),
              }),
            ),
            Layer.provide(NodeServices.layer),
          ),
        ),
        Effect.scoped,
      ),
    );
    settings = {
      ...settings,
      providers: {
        ...settings.providers,
        claudeAgent: { ...settings.providers.claudeAgent, shareStateAcrossAccounts: false },
      },
    };
    const legacy = { claudeAgent: { homePath: account.homePath } };
    expect(await select("claude_own", legacy)).toBe(legacy);
    expect(() => lstatSync(path.join(account.configPath, "projects"))).toThrow();
    settings = settingsFor();
    const selected = await select("claude_own", {
      claudeAgent: {
        binaryPath: "selected-cli",
        homePath: "caller-home",
        environment: {
          ANTHROPIC_API_KEY: "synthetic-caller-key",
          EXTRA_CALLER_SETTING: "must-not-survive",
        },
      },
    });
    expect(selected?.claudeAgent?.binaryPath).toBe("selected-cli");
    expect(selected?.claudeAgent?.environment).not.toHaveProperty("EXTRA_CALLER_SETTING");
    expect(selected?.claudeAgent?.environment?.ANTHROPIC_API_KEY).toBe("synthetic-selected-key");
    expect(readClaudeStateBinding(selected?.claudeAgent)?.record.providerInstanceId).toBe(
      "claude_own",
    );
    const current = settings.providerInstances.claude_own!;
    settings = {
      ...settings,
      providerInstances: {
        ...settings.providerInstances,
        claude_own: { ...current, enabled: false },
      },
    };
    await expect(select("claude_own", selected)).rejects.toThrow(/停用/);
    expect(() => readClaudeStateBinding(selected?.claudeAgent)).toThrow(/停用/);
    expect(claudeStateBindingReference(selected?.claudeAgent)).toBeDefined();
  });
});
