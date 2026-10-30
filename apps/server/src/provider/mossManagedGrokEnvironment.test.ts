import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { createRejectedFileAlias } from "../../../../scripts/fixtures/filesystem-links.ts";
import {
  buildMossManagedGrokConfigToml,
  buildMossManagedGrokProviderInstance,
  isVerifiedMossManagedGrokProviderInstance,
  matchesMossManagedGrokProviderInstance,
  prepareMossManagedGrokHome,
  readMossManagedGrokConfig,
  managedGrokHomeAncestors,
} from "./mossManagedGrokEnvironment";

const gateway = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
const env = { MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: gateway };
const build = (homePath = path.resolve("/tmp/moss-grok/cn")) =>
  buildMossManagedGrokProviderInstance({
    accessToken: "test-token",
    gatewayBaseUrl: gateway,
    runtimeGeneration: "generation-1",
    homePath,
    realm: "cn",
    env,
  });
const environment = (instance = build()) =>
  Object.fromEntries(instance.environment.map((entry) => [entry.name, entry.value]));
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("managed Grok isolation", () => {
  it("walks Windows drive and UNC homes without duplicating their roots", () => {
    expect(managedGrokHomeAncestors("C:\\Users\\moss\\grok", path.win32)).toEqual([
      "C:\\Users",
      "C:\\Users\\moss",
      "C:\\Users\\moss\\grok",
    ]);
    expect(managedGrokHomeAncestors("\\\\server\\share\\moss\\grok", path.win32)).toEqual([
      "\\\\server\\share\\moss",
      "\\\\server\\share\\moss\\grok",
    ]);
  });
  it("builds a secret-free, explicitly allowlisted custom model catalog", () => {
    const text = buildMossManagedGrokConfigToml(gateway, "cn");
    const config = parse(text) as any;
    expect(text).not.toContain("test-token");
    expect(config.models.allowed_models).toHaveLength(7);
    expect(config.models.session_summary).toBe(config.models.default);
    for (const id of config.models.allowed_models) {
      expect(config.model[id]).toMatchObject({
        base_url: gateway,
        env_key: "MOSS_ACCESS_TOKEN",
        api_backend: "chat_completions",
        model: id.slice(5),
      });
      expect(config.model[id].api_key).toBeUndefined();
    }
  });
  it("verifies only the exact managed instance and rejects catalog or realm tampering", () => {
    const instance = build();
    expect(
      isVerifiedMossManagedGrokProviderInstance({ instanceId: "grok_moss", instance, env }),
    ).toBe(true);
    expect(
      isVerifiedMossManagedGrokProviderInstance({ instanceId: "grok_personal", instance, env }),
    ).toBe(false);
    expect(matchesMossManagedGrokProviderInstance(instance, build())).toBe(true);
    expect(() =>
      readMossManagedGrokConfig({ ...environment(), GROK_HOME: "/other/home" }, env),
    ).toThrow();
    expect(() =>
      buildMossManagedGrokProviderInstance({
        accessToken: "token",
        gatewayBaseUrl: "https://evil.example/v1",
        runtimeGeneration: "g",
        homePath: "/tmp/grok",
        realm: "cn",
        env,
      }),
    ).toThrow();
    const changed = { ...instance, config: { ...instance.config, realm: "global" } };
    expect(
      isVerifiedMossManagedGrokProviderInstance({
        instanceId: "grok_moss",
        instance: changed,
        env,
      }),
    ).toBe(false);
  });
  it("writes only a canonical isolated home, never a linked home or config", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "moss-grok-test-")));
    homes.push(root);
    const home = path.join(root, "cn");
    const config = readMossManagedGrokConfig(environment(build(home)), env)!;
    await prepareMossManagedGrokHome(config);
    expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(
      buildMossManagedGrokConfigToml(gateway, "cn"),
    );
    const target = path.join(root, "outside.toml");
    await writeFile(target, "preserve");
    await rm(path.join(home, "config.toml"));
    createRejectedFileAlias(target, path.join(home, "config.toml"));
    await expect(prepareMossManagedGrokHome(config)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("preserve");
    const linked = path.join(root, "linked");
    await symlink(home, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(prepareMossManagedGrokHome({ ...config, homePath: linked })).rejects.toThrow();
  });
});
