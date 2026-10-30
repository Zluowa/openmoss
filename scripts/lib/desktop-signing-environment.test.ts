import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import {
  APPLE_ELECTRON_BUILDER_SIGNING_ENV_KEYS,
  createDesktopBuildSubprocessEnvironment,
  createElectronBuilderEnvironment,
  createNonSigningSubprocessEnvironment,
  DESKTOP_SIGNING_BOUNDARY_ENV_KEYS,
  WINDOWS_ELECTRON_BUILDER_SIGNING_ENV_KEYS,
} from "./desktop-signing-environment.ts";

function credentialEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries([
    ...DESKTOP_SIGNING_BOUNDARY_ENV_KEYS.map((key) => [key, `secret:${key}`]),
    ["SAFE_BUILD_VALUE", "retained"],
  ]);
}

const EXECUTABLE_INJECTION_ENV_KEYS = [
  "NODE_OPTIONS",
  "node_options",
  "BUN_OPTIONS",
  "bun_options",
  "NODE_PATH",
  "node_path",
  "NPM_CONFIG_NODE_OPTIONS",
  "npm_config_node_options",
  "ELECTRON_RUN_AS_NODE",
  "electron_run_as_node",
  "OPENSSL_CONF",
  "openssl_conf",
  "LD_PRELOAD",
  "ld_preload",
  "LD_AUDIT",
  "ld_audit",
  "DYLD_INSERT_LIBRARIES",
  "dyld_insert_libraries",
] as const;

function executableInjectionEnvironment(): NodeJS.ProcessEnv {
  return {
    ...credentialEnvironment(),
    NODE_OPTIONS: "--require=/fixture/preload.cjs --import=/fixture/preload.mjs",
    node_options: "--require=/fixture/case-variant.cjs",
    BUN_OPTIONS: "--preload=/fixture/preload.ts",
    bun_options: "--preload=/fixture/case-variant.ts",
    NODE_PATH: "/fixture/modules",
    node_path: "/fixture/case-variant-modules",
    NPM_CONFIG_NODE_OPTIONS: "--require=/fixture/npm-preload.cjs",
    npm_config_node_options: "--import=/fixture/npm-preload.mjs",
    ELECTRON_RUN_AS_NODE: "1",
    electron_run_as_node: "1",
    OPENSSL_CONF: "/fixture/openssl.cnf",
    openssl_conf: "/fixture/case-variant-openssl.cnf",
    LD_PRELOAD: "/fixture/libinject.dylib",
    ld_preload: "/fixture/case-variant-libinject.dylib",
    LD_AUDIT: "/fixture/audit.so",
    ld_audit: "/fixture/case-variant-audit.so",
    DYLD_INSERT_LIBRARIES: "/fixture/libinject.dylib",
    dyld_insert_libraries: "/fixture/case-variant-libinject.dylib",
  };
}

describe("desktop signing subprocess environments", () => {
  it("removes every signing-boundary value from non-signing subprocesses without mutation", () => {
    const source = credentialEnvironment();
    source.ssl_com_es_password = "mixed-case-secret";

    const sanitized = createNonSigningSubprocessEnvironment(source);

    assert.equal(sanitized.SAFE_BUILD_VALUE, "retained");
    for (const key of Object.keys(sanitized)) {
      assert.ok(
        !DESKTOP_SIGNING_BOUNDARY_ENV_KEYS.some(
          (signingKey) => signingKey.toUpperCase() === key.toUpperCase(),
        ),
      );
    }
    assert.equal(source.SSL_COM_ES_PASSWORD, "secret:SSL_COM_ES_PASSWORD");
    assert.equal(source.ssl_com_es_password, "mixed-case-secret");
  });

  it("replaces host Node options and fixes Turbo concurrency for desktop builds", () => {
    const source = {
      ...credentialEnvironment(),
      NODE_OPTIONS: "--require=/host/inject.js --import=/host/inject.mjs",
      TURBO_CONCURRENCY: "8",
    };

    const buildEnvironment = createDesktopBuildSubprocessEnvironment(source);

    assert.equal(buildEnvironment.NODE_OPTIONS, "--max-old-space-size=8192");
    assert.equal(buildEnvironment.TURBO_CONCURRENCY, "1");
    assert.equal(buildEnvironment.SAFE_BUILD_VALUE, "retained");
    for (const key of DESKTOP_SIGNING_BOUNDARY_ENV_KEYS) {
      assert.equal(buildEnvironment[key], undefined);
    }
    assert.equal(source.NODE_OPTIONS, "--require=/host/inject.js --import=/host/inject.mjs");
    assert.equal(source.TURBO_CONCURRENCY, "8");
  });

  it("removes executable injection variables for signed and unsigned builder environments without mutation", () => {
    for (const input of [
      { platform: "mac" as const, signed: true },
      { platform: "win" as const, signed: true },
      { platform: "mac" as const, signed: false },
      { platform: "win" as const, signed: false },
      { platform: "linux" as const, signed: false },
    ]) {
      const source = executableInjectionEnvironment();
      const snapshot = { ...source };
      const builderEnv = createElectronBuilderEnvironment({ env: source, ...input });

      assert.equal(builderEnv.SAFE_BUILD_VALUE, "retained");
      for (const key of EXECUTABLE_INJECTION_ENV_KEYS) {
        assert.equal(builderEnv[key], undefined);
      }
      assert.deepEqual(source, snapshot);

      const expectedSigningKeys =
        input.signed && input.platform === "mac"
          ? APPLE_ELECTRON_BUILDER_SIGNING_ENV_KEYS
          : input.signed && input.platform === "win"
            ? WINDOWS_ELECTRON_BUILDER_SIGNING_ENV_KEYS
            : [];
      const expectedSigningKeySet = new Set<string>(expectedSigningKeys);
      for (const key of DESKTOP_SIGNING_BOUNDARY_ENV_KEYS) {
        if (expectedSigningKeySet.has(key)) {
          assert.equal(builderEnv[key], `secret:${key}`);
        } else if (key === "CSC_IDENTITY_AUTO_DISCOVERY") {
          assert.equal(builderEnv[key], "false");
        } else {
          assert.equal(builderEnv[key], undefined);
        }
      }
    }
  });

  it("gives a signed macOS electron-builder only Apple signing values", () => {
    const builderEnv = createElectronBuilderEnvironment({
      env: credentialEnvironment(),
      platform: "mac",
      signed: true,
    });

    for (const key of APPLE_ELECTRON_BUILDER_SIGNING_ENV_KEYS) {
      assert.equal(builderEnv[key], `secret:${key}`);
    }
    for (const key of WINDOWS_ELECTRON_BUILDER_SIGNING_ENV_KEYS) {
      assert.equal(builderEnv[key], undefined);
    }
  });

  it("gives a signed Windows electron-builder only SSL.com signing values", () => {
    const env = credentialEnvironment();
    env.ssl_com_es_password = "attacker-controlled-alias";
    const builderEnv = createElectronBuilderEnvironment({
      env,
      platform: "win",
      signed: true,
    });

    for (const key of WINDOWS_ELECTRON_BUILDER_SIGNING_ENV_KEYS) {
      assert.equal(builderEnv[key], `secret:${key}`);
    }
    for (const key of APPLE_ELECTRON_BUILDER_SIGNING_ENV_KEYS) {
      assert.equal(builderEnv[key], key === "CSC_IDENTITY_AUTO_DISCOVERY" ? "false" : undefined);
    }
    assert.equal(builderEnv.ssl_com_es_password, undefined);
  });

  it("removes signing values and disables discovery for unsigned and Linux builders", () => {
    for (const input of [
      { platform: "win" as const, signed: false },
      { platform: "linux" as const, signed: true },
    ]) {
      const builderEnv = createElectronBuilderEnvironment({
        env: { ...credentialEnvironment(), EMPTY_VALUE: "" },
        ...input,
      });

      assert.equal(builderEnv.SAFE_BUILD_VALUE, "retained");
      assert.equal(builderEnv.EMPTY_VALUE, undefined);
      assert.equal(builderEnv.CSC_IDENTITY_AUTO_DISCOVERY, "false");
      for (const key of DESKTOP_SIGNING_BOUNDARY_ENV_KEYS) {
        if (key !== "CSC_IDENTITY_AUTO_DISCOVERY") {
          assert.equal(builderEnv[key], undefined);
        }
      }
    }
  });

  it("keeps every build helper outside the one electron-builder signing boundary sanitized", () => {
    const buildSource = readFileSync(
      new URL("../build-desktop-artifact.ts", import.meta.url),
      "utf8",
    );
    const finalizeSource = readFileSync(
      new URL("./mac-update-zip-finalize.ts", import.meta.url),
      "utf8",
    );
    const spawnSyncCalls = buildSource.match(/spawnSync\(/g) ?? [];
    const sanitizedSpawnSyncCalls =
      buildSource.match(
        /spawnSync\([\s\S]*?env:\s*createNonSigningSubprocessEnvironment\(process\.env\)/g,
      ) ?? [];
    const nonSigningEnvironmentCalls =
      buildSource.match(/createNonSigningSubprocessEnvironment\(process\.env\)/g) ?? [];
    const desktopBuildEnvironmentCalls =
      buildSource.match(/createDesktopBuildSubprocessEnvironment\(process\.env\)/g) ?? [];

    assert.equal(buildSource.match(/ChildProcess\.make/g)?.length, 12);
    assert.equal(spawnSyncCalls.length, sanitizedSpawnSyncCalls.length);
    assert.equal(nonSigningEnvironmentCalls.length, 13);
    assert.equal(desktopBuildEnvironmentCalls.length, 1);
    assert.match(
      buildSource,
      /const buildEnv = createElectronBuilderEnvironment\([\s\S]*?const electronBuilderCliPath = requireFromScriptsWorkspace\.resolve\("electron-builder\/cli\.js"\);[\s\S]*?ChildProcess\.make\(\s*process\.execPath,\s*\[[\s\S]*?electronBuilderCliPath,[\s\S]*?env: buildEnv/,
    );
    assert.match(
      buildSource,
      /ChildProcess\.make\(\{[\s\S]*?env: createDesktopBuildSubprocessEnvironment\(process\.env\)[\s\S]*?\}\)`bun run build:desktop --force`/,
    );
    assert.match(
      buildSource,
      /const rebuildStagedLinuxNodePty[\s\S]*?ChildProcess\.make\("node", \[rebuildInput\.cliPath, \.\.\.rebuildInput\.args\], \{\s*cwd: stageAppDir,/,
    );
    assert.match(
      finalizeSource,
      /spawnSync\([\s\S]*?env: createNonSigningSubprocessEnvironment\(process\.env\)/,
    );
  });
});
