import { lstat, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRejectedFileAlias } from "../../../../scripts/fixtures/filesystem-links.ts";
import {
  KIMI_ACP_AGENT_SPEC,
  MINIMAX_ACP_AGENT_SPEC,
  ZCODE_ACP_AGENT_SPEC,
  type AcpAgentKind,
  type AcpAgentSpec,
} from "./acp/AcpAgentSpec.ts";
import { buildAcpAgentSpawnInput } from "./acp/AcpAgentSupport.ts";
import {
  buildMossManagedAcpAgentProviderInstance,
  isVerifiedMossManagedAcpAgentProviderInstance,
  MOSS_MANAGED_ACP_AGENT_CONFIG_ENV_KEYS,
  MOSS_MANAGED_ACP_AGENT_MODEL_PREFIXES,
  mossManagedAcpAgentModels,
  mossManagedKimiModelId,
  mossManagedMinimaxModelId,
  mossManagedZcodeModelId,
  prepareMossManagedAcpAgentHome,
  readMossManagedAcpAgentCatalog,
} from "./mossManagedAcpAgentEnvironment.ts";
import { matchesMossManagedRelayProviderInstance } from "./mossManagedRelayInstance.ts";

const gateway = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
const env = { MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: gateway };
const SPECS: Readonly<Record<AcpAgentKind, AcpAgentSpec>> = {
  kimi: KIMI_ACP_AGENT_SPEC,
  minimax: MINIMAX_ACP_AGENT_SPEC,
  zcode: ZCODE_ACP_AGENT_SPEC,
};
const KINDS = Object.keys(SPECS) as ReadonlyArray<AcpAgentKind>;
const homePathFor = (kind: AcpAgentKind) =>
  path.resolve(path.sep, "moss-state", "provider-homes", kind, "cn");
const build = (
  kind: AcpAgentKind,
  overrides: Partial<Parameters<typeof buildMossManagedAcpAgentProviderInstance>[1]> = {},
) =>
  buildMossManagedAcpAgentProviderInstance(SPECS[kind], {
    accessToken: "test-token",
    gatewayBaseUrl: gateway,
    runtimeGeneration: "generation-1",
    homePath: homePathFor(kind),
    realm: "cn",
    env,
    ...overrides,
  });
const environmentOf = (instance: ReturnType<typeof build>) =>
  Object.fromEntries(instance.environment.map((entry) => [entry.name, entry.value]));
const managedSettings = (kind: AcpAgentKind, instance = build(kind)) => ({
  environment: environmentOf(instance),
  homePath: homePathFor(kind),
});

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function temporaryHome(kind: AcpAgentKind) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `moss-${kind}-managed-`)));
  homes.push(root);
  return { root, homePath: path.join(root, kind, "cn") };
}

describe.each(KINDS)("managed %s relay instance", (kind) => {
  const spec = SPECS[kind];
  const instanceId = `${kind}_moss`;
  const configEnvKey = MOSS_MANAGED_ACP_AGENT_CONFIG_ENV_KEYS[kind];

  it("builds a verified instance whose config and catalog never carry the bearer", () => {
    const instance = build(kind);
    expect(instance).toMatchObject({
      driver: kind,
      displayName: "Moss",
      enabled: true,
      config: {
        managed: true,
        realm: "cn",
        homePath: homePathFor(kind),
        gatewayBaseUrl: gateway,
        credentialEnvKey: "MOSS_ACCESS_TOKEN",
        runtimeGeneration: "generation-1",
        defaultModel: instance.config.modelAllowlist[0],
      },
    });
    expect(instance.config.customModels).toEqual(instance.config.modelAllowlist);
    expect(instance.config.modelAllowlist).toEqual(mossManagedAcpAgentModels(kind, "cn"));
    expect(instance.config.modelAllowlist.length).toBeGreaterThan(0);
    for (const model of instance.config.modelAllowlist) {
      expect(model.startsWith(MOSS_MANAGED_ACP_AGENT_MODEL_PREFIXES[kind])).toBe(true);
    }
    expect(instance.environment).toEqual([
      { name: configEnvKey, value: expect.any(String), sensitive: false },
      { name: "MOSS_ACCESS_TOKEN", value: "test-token", sensitive: true },
    ]);
    expect(JSON.stringify(instance.config)).not.toContain("test-token");
    expect(instance.environment[0]!.value).not.toContain("test-token");
    expect(readMossManagedAcpAgentCatalog(spec, environmentOf(instance), env)).toEqual({
      realm: "cn",
      gatewayBaseUrl: gateway,
      homePath: homePathFor(kind),
      models: instance.config.modelAllowlist,
    });
    expect(isVerifiedMossManagedAcpAgentProviderInstance(spec, { instanceId, instance, env })).toBe(
      true,
    );
    expect(
      isVerifiedMossManagedAcpAgentProviderInstance(spec, {
        instanceId: `${kind}_moss_copy`,
        instance,
        env,
      }),
    ).toBe(false);
    for (const other of KINDS.filter((candidate) => candidate !== kind)) {
      expect(
        isVerifiedMossManagedAcpAgentProviderInstance(SPECS[other], {
          instanceId: `${other}_moss`,
          instance,
          env,
        }),
      ).toBe(false);
    }
  });

  it("rejects untrusted gateways, malformed homes, tampered catalogs and missing credentials", () => {
    expect(() => build(kind, { gatewayBaseUrl: "https://foreign.example/v1" })).toThrow(
      "trusted Moss gateway",
    );
    expect(() => build(kind, { homePath: "." })).toThrow("canonical absolute isolated home");
    expect(() => build(kind, { runtimeGeneration: " " })).toThrow("runtime generation");
    const instance = build(kind);
    const environment = environmentOf(instance);
    const catalog = JSON.parse(environment[configEnvKey]!) as { models: string[] };
    expect(() =>
      readMossManagedAcpAgentCatalog(
        spec,
        { ...environment, [configEnvKey]: JSON.stringify({ ...catalog, models: ["gpt-5.6-sol"] }) },
        env,
      ),
    ).toThrow("does not match its realm catalog");
    // The home is identity carried by the catalog: a retargeted catalog still
    // decodes, but no longer proves the stored config and is refused there.
    const retargeted = JSON.stringify({ ...catalog, homePath: path.resolve(path.sep, "personal") });
    expect(
      readMossManagedAcpAgentCatalog(spec, { ...environment, [configEnvKey]: retargeted }, env),
    ).toMatchObject({ homePath: path.resolve(path.sep, "personal") });
    expect(
      isVerifiedMossManagedAcpAgentProviderInstance(spec, {
        instanceId,
        instance: {
          ...instance,
          environment: [
            { ...instance.environment[0]!, value: retargeted },
            instance.environment[1]!,
          ],
        },
        env,
      }),
    ).toBe(false);
    expect(() =>
      readMossManagedAcpAgentCatalog(spec, { ...environment, MOSS_ACCESS_TOKEN: " " }, env),
    ).toThrow("Moss access token");
    expect(() => readMossManagedAcpAgentCatalog(spec, environment, {})).toThrow(
      "trusted Moss gateway",
    );
    expect(readMossManagedAcpAgentCatalog(spec, { OTHER: "x" }, env)).toBeUndefined();
    for (const config of [
      { ...instance.config, realm: "global" },
      { ...instance.config, binaryPath: "/untrusted" },
      { ...instance.config, modelAllowlist: ["gpt-5.6-sol"] },
    ]) {
      expect(
        isVerifiedMossManagedAcpAgentProviderInstance(spec, {
          instanceId,
          instance: { ...instance, config },
          env,
        }),
      ).toBe(false);
    }
  });

  it("accepts credential-free cleanup tombstones only when allowed and tracks rotation", () => {
    const instance = build(kind);
    const disabled = {
      ...instance,
      enabled: false,
      environment: [],
      config: { ...instance.config, managedCleanupState: "pending-v1" },
    };
    expect(
      isVerifiedMossManagedAcpAgentProviderInstance(spec, { instanceId, instance: disabled, env }),
    ).toBe(false);
    expect(
      isVerifiedMossManagedAcpAgentProviderInstance(spec, {
        instanceId,
        instance: disabled,
        allowDisabled: true,
        env,
      }),
    ).toBe(true);
    expect(
      isVerifiedMossManagedAcpAgentProviderInstance(spec, {
        instanceId,
        instance: { ...disabled, config: { ...instance.config, managedCleanupState: "other" } },
        allowDisabled: true,
        env,
      }),
    ).toBe(false);
    expect(matchesMossManagedRelayProviderInstance(instance, build(kind))).toBe(true);
    expect(
      matchesMossManagedRelayProviderInstance(
        instance,
        build(kind, { runtimeGeneration: "generation-2" }),
      ),
    ).toBe(false);
    expect(
      matchesMossManagedRelayProviderInstance(instance, build(kind, { accessToken: "rotated" })),
    ).toBe(false);
    expect(matchesMossManagedRelayProviderInstance(disabled, build(kind))).toBe(false);
  });

  it("only claims the reserved instance when the launch home is the catalog home", () => {
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
    const hooks = spec.managed!;
    const settings = managedSettings(kind);
    expect(hooks.readConfig(settings)).toMatchObject({ realm: "cn", homePath: settings.homePath });
    expect(() => hooks.readConfig({ environment: settings.environment })).toThrow(
      "isolated realm home",
    );
    expect(() =>
      hooks.readConfig({ environment: settings.environment, homePath: "/personal/cli" }),
    ).toThrow("isolated realm home");
    expect(hooks.readConfig({ environment: { OTHER: "x" }, homePath: settings.homePath })).toBe(
      undefined,
    );
  });

  it("lists the realm catalog without the CLI and maps Moss slugs to the CLI's model values", () => {
    const hooks = spec.managed!;
    const config = readMossManagedAcpAgentCatalog(spec, environmentOf(build(kind)), env)!;
    const listed = hooks.listModels(config);
    expect(listed.source).toBe(`moss-managed-${kind}`);
    expect(listed.models.map((model) => model.slug)).toEqual(config.models);
    expect(listed.models.every((model) => model.name !== model.slug)).toBe(true);
    const expectedId = {
      kimi: mossManagedKimiModelId,
      minimax: mossManagedMinimaxModelId,
      zcode: mossManagedZcodeModelId,
    }[kind];
    for (const slug of config.models) {
      expect(hooks.modelId!(` ${slug} `, config)).toBe(expectedId(slug));
    }
  });

  it("writes only private 0700 directories and 0600 files, refusing linked homes and files", async () => {
    const { root, homePath } = await temporaryHome(kind);
    const instance = build(kind, { homePath });
    const settings = { environment: environmentOf(instance), homePath };
    const config = readMossManagedAcpAgentCatalog(spec, settings.environment, env)!;
    await prepareMossManagedAcpAgentHome(spec, config, settings);
    const dataRoot = Object.values(spec.homeEnvironment(homePath))[0]!;
    const files = {
      kimi: ["config.toml"],
      minimax: ["config.yaml"],
      zcode: [path.join("v2", "provider_config.json"), path.join("v2", "config.json")],
    }[kind];
    for (const file of files) {
      const target = path.join(dataRoot, file);
      const entry = await lstat(target);
      expect(entry.isFile()).toBe(true);
      expect(entry.isSymbolicLink()).toBe(false);
      if (process.platform !== "win32") {
        expect((await stat(target)).mode & 0o777).toBe(0o600);
        expect((await stat(path.dirname(target))).mode & 0o777).toBe(0o700);
        expect((await stat(homePath)).mode & 0o777).toBe(0o700);
      }
    }
    // Rewrites are atomic and track the current bearer.
    const rotated = build(kind, { homePath, accessToken: "rotated-token" });
    await prepareMossManagedAcpAgentHome(spec, config, {
      environment: environmentOf(rotated),
      homePath,
    });
    const contents = await Promise.all(
      files.map((file) => readFile(path.join(dataRoot, file), "utf8")),
    );
    expect(contents.join("\n")).not.toContain("test-token");
    expect(contents.join("\n").includes("rotated-token")).toBe(kind === "zcode");
    // A linked config target is refused and its destination untouched.
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "preserve");
    const linkedFile = path.join(dataRoot, files[0]!);
    await rm(linkedFile);
    createRejectedFileAlias(outside, linkedFile);
    await expect(prepareMossManagedAcpAgentHome(spec, config, settings)).rejects.toThrow(
      "regular file",
    );
    expect(await readFile(outside, "utf8")).toBe("preserve");
    // A linked home ancestor is refused before anything is created behind it.
    const linkedHome = path.join(root, "linked");
    await symlink(
      path.dirname(homePath),
      linkedHome,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      prepareMossManagedAcpAgentHome(
        spec,
        { ...config, homePath: path.join(linkedHome, "cn") },
        settings,
      ),
    ).rejects.toThrow("symlink");
  });

  it("spawns from a minimal environment that ignores the user's own CLI data and credentials", () => {
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
    vi.stubEnv("KIMI_CODE_HOME", "/personal/.kimi-code");
    vi.stubEnv("MINIMAX_DATA_DIR", "/personal/.minimax");
    vi.stubEnv("ZCODE_HOME", "/personal/.zcode");
    vi.stubEnv("ZCODE_ACP_MODE", "yolo");
    vi.stubEnv("OPENAI_API_KEY", "foreign-key");
    vi.stubEnv("MOSS_CONTROL_PLANE_SECRET", "server-only");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "corporate.local");
    const settings = managedSettings(kind);
    const config = spec.managed!.readConfig(settings)!;
    const spawn = buildAcpAgentSpawnInput(spec, { ...settings, managed: config }, "/workspace");
    expect(spawn.command).toBe(spec.command);
    expect(spawn.env).toMatchObject(spec.homeEnvironment(settings.homePath));
    expect(spawn.env?.PATH).toBe(process.env.PATH);
    expect(spawn.env?.HTTPS_PROXY).toBe("http://proxy.test:8080");
    expect(spawn.env?.NO_PROXY).toContain("corporate.local");
    expect(spawn.env?.NO_PROXY).toContain("127.0.0.1");
    expect(spawn.env?.OPENAI_API_KEY).toBeUndefined();
    expect(spawn.env?.MOSS_CONTROL_PLANE_SECRET).toBeUndefined();
    expect(spawn.env?.[configEnvKey]).toBeUndefined();
    for (const key of ["KIMI_CODE_HOME", "MINIMAX_DATA_DIR", "ZCODE_HOME", "ZCODE_ACP_MODE"]) {
      expect(spawn.env?.[key] ?? "").not.toMatch(/^\/personal\/|^yolo$/u);
    }
    if (kind === "zcode") {
      expect(spawn.env?.MOSS_ACCESS_TOKEN).toBeUndefined();
      expect(spawn.inheritedMossKeys).toBeUndefined();
    } else {
      expect(spawn.env?.MOSS_ACCESS_TOKEN).toBe("test-token");
      expect(spawn.inheritedMossKeys).toEqual(["MOSS_ACCESS_TOKEN"]);
    }
  });
});

describe("managed Kimi Code recipe", () => {
  it("generates an env-keyed openai provider with the family models and effort ladders", async () => {
    const { homePath } = await temporaryHome("kimi");
    const instance = build("kimi", { homePath });
    const settings = { environment: environmentOf(instance), homePath };
    const config = readMossManagedAcpAgentCatalog(KIMI_ACP_AGENT_SPEC, settings.environment, env)!;
    await prepareMossManagedAcpAgentHome(KIMI_ACP_AGENT_SPEC, config, settings);
    const text = await readFile(path.join(homePath, "config.toml"), "utf8");
    const toml = parseToml(text) as any;
    expect(toml.default_model).toBe("moss/kimi-k3");
    expect(toml.telemetry).toBe(false);
    expect(toml.providers.moss).toEqual({
      type: "openai",
      base_url: gateway,
      api_key_env: "MOSS_ACCESS_TOKEN",
    });
    expect(toml.models["moss/kimi-k3"]).toMatchObject({
      provider: "moss",
      model: "kimi-k3",
      display_name: "Kimi K3",
      max_context_size: 1_048_576,
      max_output_size: 32_768,
      capabilities: ["thinking", "image_in", "tool_use"],
      support_efforts: ["low", "high", "max"],
      default_effort: "high",
    });
    expect(Object.keys(toml.models)).toEqual(config.models.map(mossManagedKimiModelId));
    const spawn = buildAcpAgentSpawnInput(
      KIMI_ACP_AGENT_SPEC,
      { ...settings, managed: config },
      "/workspace",
    );
    expect(spawn.env).toMatchObject({
      KIMI_CODE_HOME: homePath,
      KIMI_DISABLE_TELEMETRY: "1",
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_MODEL_MAX_COMPLETION_TOKENS: "32768",
    });
    expect(mossManagedKimiModelId("kimi-k3")).toBe("moss/kimi-k3");
  });
});

describe("managed MiniMax Code recipe", () => {
  it("generates a chat-completions custom provider whose key is a whole-value env reference", async () => {
    const { homePath } = await temporaryHome("minimax");
    const instance = build("minimax", { homePath });
    const settings = { environment: environmentOf(instance), homePath };
    const config = readMossManagedAcpAgentCatalog(
      MINIMAX_ACP_AGENT_SPEC,
      settings.environment,
      env,
    )!;
    await prepareMossManagedAcpAgentHome(MINIMAX_ACP_AGENT_SPEC, config, settings);
    const text = await readFile(path.join(homePath, "config.yaml"), "utf8");
    // JSON is valid YAML; the CLI parses the file with a YAML loader.
    const yaml = JSON.parse(text);
    expect(yaml.defaultModel).toBe("custom_provider:moss/minimax-m3");
    expect(yaml.custom_provider.moss).toMatchObject({
      name: "Moss",
      kind: "custom",
      enabled: true,
      api: "openai-completions",
      options: { authMode: "api-key", baseURL: gateway, apiKey: "${MOSS_ACCESS_TOKEN}" },
    });
    expect(yaml.custom_provider.moss.models["minimax-m3"]).toEqual({
      name: "MiniMax M3",
      limit: { context: 524_288, output: 32_768 },
      tool_call: true,
      reasoning: true,
    });
    expect(Object.keys(yaml.custom_provider.moss.models)).toEqual(config.models);
    expect(
      buildAcpAgentSpawnInput(
        MINIMAX_ACP_AGENT_SPEC,
        { ...settings, managed: config },
        "/workspace",
      ).env,
    ).toMatchObject({ MINIMAX_DATA_DIR: homePath, MOSS_ACCESS_TOKEN: "test-token" });
    expect(mossManagedMinimaxModelId("minimax-m3")).toBe("m:custom_provider%3Amoss:minimax-m3:u");
  });
});

describe("managed ZCode recipe", () => {
  it("writes the personal provider table plus its legacy mirror under a `.zcode` home and pins the model", async () => {
    vi.stubEnv("ZCODE_BIN", "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs");
    vi.stubEnv("ZCODE_NODE", " ");
    const { homePath } = await temporaryHome("zcode");
    const instance = build("zcode", { homePath });
    const settings = { environment: environmentOf(instance), homePath };
    const config = readMossManagedAcpAgentCatalog(ZCODE_ACP_AGENT_SPEC, settings.environment, env)!;
    await prepareMossManagedAcpAgentHome(ZCODE_ACP_AGENT_SPEC, config, settings);
    const zcodeHome = path.join(homePath, ".zcode");
    const personal = JSON.parse(
      await readFile(path.join(zcodeHome, "v2", "provider_config.json"), "utf8"),
    );
    expect(personal).toEqual({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "moss",
              providerName: "Moss",
              enabled: true,
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "test-token" },
                api: { type: "openai-chat-completions", baseUrl: gateway },
                personalModelIds: ["glm-5.3", "glm-5.3-flash"],
              },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: { providerId: "moss", modelId: "glm-5.3" },
      },
    });
    const legacy = JSON.parse(await readFile(path.join(zcodeHome, "v2", "config.json"), "utf8"));
    expect(legacy.provider.moss).toMatchObject({
      name: "Moss",
      kind: "openai-compatible",
      enabled: true,
      source: "custom",
      options: { baseURL: gateway, apiKey: "test-token" },
    });
    expect(legacy.provider.moss.models["glm-5.3"]).toEqual({
      name: "GLM-5.3",
      limit: { context: 1_048_576, output: 32_768 },
      reasoning: { enabled: true, variants: ["low", "high", "max"], defaultVariant: "high" },
    });
    expect(legacy.provider.moss.models["glm-5.3-flash"].reasoning.variants).toEqual([
      "low",
      "high",
    ]);
    const spawn = buildAcpAgentSpawnInput(
      ZCODE_ACP_AGENT_SPEC,
      { ...settings, managed: config },
      "/workspace",
    );
    expect(spawn.env).toMatchObject({
      ZCODE_HOME: zcodeHome,
      ZCODE_PROVIDER: "moss",
      ZCODE_MODEL: "glm-5.3",
      ZCODE_ACP_MODE: "build",
      ZCODE_ACP_SHOW_COMPLETION_STATUS: "0",
      ZCODE_BIN: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    });
    // Shell tools the agent runs (git, gh) keep their own XDG config.
    expect(spawn.env?.XDG_CONFIG_HOME).toBeUndefined();
    expect(path.basename(spawn.env!.ZCODE_HOME!)).toBe(".zcode");
    expect(spawn.env?.ZCODE_NODE).toBeUndefined();
    expect(spawn.env?.MOSS_ACCESS_TOKEN).toBeUndefined();
    expect(mossManagedZcodeModelId("glm-5.3")).toBe("moss\\glm-5.3");
  });
});
