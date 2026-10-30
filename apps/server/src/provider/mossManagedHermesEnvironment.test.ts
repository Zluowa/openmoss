import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildMossManagedHermesProviderInstance,
  isVerifiedMossManagedHermesProviderInstance,
  readMossManagedHermesConfig,
  buildMossManagedHermesConfig,
  managedHermesHomeAncestors,
  prepareMossManagedHermesHome,
} from "./mossManagedHermesEnvironment";
const gatewayBaseUrl = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
const env = { MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: gatewayBaseUrl };
const fixture = () =>
  buildMossManagedHermesProviderInstance({
    accessToken: "test-token",
    gatewayBaseUrl,
    runtimeGeneration: "generation",
    homePath: "/state/hermes/cn",
    realm: "cn",
    env,
  });
describe("managed Hermes", () => {
  it("enumerates Windows drive and UNC ancestors without reinterpreting their roots", () => {
    expect(managedHermesHomeAncestors("C:\\Users\\Moss\\hermes", path.win32)).toEqual([
      "C:\\Users",
      "C:\\Users\\Moss",
      "C:\\Users\\Moss\\hermes",
    ]);
    expect(managedHermesHomeAncestors("\\\\server\\share\\Moss\\hermes", path.win32)).toEqual([
      "\\\\server\\share\\Moss",
      "\\\\server\\share\\Moss\\hermes",
    ]);
  });
  it("rejects linked ancestors before creating any child outside the isolated home", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "moss-hermes-symlink-")));
    try {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await symlink(
        outside,
        path.join(root, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        prepareMossManagedHermesHome(
          path.join(root, "linked", "cn"),
          buildMossManagedHermesConfig(gatewayBaseUrl, "cn"),
        ),
      ).rejects.toThrow("symlink");
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects machine configuration overlays in its private managed directory", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "moss-hermes-overlay-")));
    try {
      await mkdir(path.join(root, "managed-config"));
      await writeFile(path.join(root, "managed-config", "config.yaml"), "model: foreign");
      await expect(
        prepareMossManagedHermesHome(root, buildMossManagedHermesConfig(gatewayBaseUrl, "cn")),
      ).rejects.toThrow("must be empty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("uses explicit custom routing and keeps credentials out of config", () => {
    const instance = fixture();
    expect(
      isVerifiedMossManagedHermesProviderInstance({ instanceId: "hermes_moss", instance, env }),
    ).toBe(true);
    const environment = Object.fromEntries(
      instance.environment.map((entry) => [entry.name, entry.value]),
    );
    const config = readMossManagedHermesConfig(environment, env)!;
    expect(config.configuration.model.provider).toBe("custom:moss");
    expect(config.configuration.custom_providers[1]).toEqual({
      ...config.configuration.custom_providers[0],
      name: "custom",
    });
    expect(config.configuration.custom_providers[0]?.key_env).toBe("MOSS_ACCESS_TOKEN");
    expect(
      config.configuration.custom_providers[0]?.models["kimi-k3"]?.context_length,
    ).toBeGreaterThan(64_000);
    expect(JSON.stringify(config)).not.toContain("test-token");
    expect(instance.config.modelAllowlist).toHaveLength(7);
  });
  it("rejects lookalike ids, executable overrides, cross realm, and malformed home", () => {
    const instance = fixture();
    expect(
      isVerifiedMossManagedHermesProviderInstance({
        instanceId: "hermes_moss_copy",
        instance,
        env,
      }),
    ).toBe(false);
    expect(
      isVerifiedMossManagedHermesProviderInstance({
        instanceId: "hermes_moss",
        instance: { ...instance, config: { ...instance.config, binaryPath: "/untrusted" } },
        env,
      }),
    ).toBe(false);
    expect(() =>
      buildMossManagedHermesProviderInstance({
        accessToken: "token",
        gatewayBaseUrl: "https://foreign.example/v1",
        runtimeGeneration: "g",
        homePath: "/state/hermes",
        realm: "cn",
        env,
      }),
    ).toThrow();
    expect(() =>
      buildMossManagedHermesProviderInstance({
        accessToken: "token",
        gatewayBaseUrl,
        runtimeGeneration: "g",
        homePath: ".",
        realm: "cn",
        env,
      }),
    ).toThrow();
  });
  it("requires exact canonical config and a nonempty credential", () => {
    const instance = fixture();
    const environment = Object.fromEntries(
      instance.environment.map((entry) => [entry.name, entry.value]),
    );
    const config = JSON.parse(environment.MOSS_HERMES_CONFIG_CONTENT!);
    config.configuration.custom_providers[0].base_url = "https://foreign.example/v1";
    expect(() =>
      readMossManagedHermesConfig(
        { ...environment, MOSS_HERMES_CONFIG_CONTENT: JSON.stringify(config) },
        env,
      ),
    ).toThrow();
    expect(() =>
      readMossManagedHermesConfig({ ...environment, MOSS_ACCESS_TOKEN: "" }, env),
    ).toThrow();
  });
});
