import { assert, describe, it } from "@effect/vitest";

import {
  APPLE_RELEASE_SIGNING_ENV_KEYS,
  requiresMacUpdateManifest,
  validateDesktopReleaseBuildPolicy,
  validateWindowsSigningEnvironment,
  WINDOWS_SSL_COM_RELEASE_SIGNING_ENV_KEYS,
} from "./desktop-release-build-policy.ts";

function envWith(keys: ReadonlyArray<string>): NodeJS.ProcessEnv {
  return Object.fromEntries(keys.map((key) => [key, `test-${key.toLowerCase()}`]));
}

describe("validateDesktopReleaseBuildPolicy", () => {
  it("requires a macOS update manifest only for publish releases", () => {
    assert.equal(requiresMacUpdateManifest("build-only"), false);
    assert.equal(requiresMacUpdateManifest("publish"), true);
  });

  it("allows explicitly unsigned build-only artifacts for internal QA", () => {
    for (const platform of ["mac", "linux", "win"] as const) {
      assert.doesNotThrow(() =>
        validateDesktopReleaseBuildPolicy({
          env: {},
          platform,
          productionConfigMode: "off",
          releaseMode: "build-only",
          signed: false,
        }),
      );
    }
  });

  it("requires strict production public configuration for every public release", () => {
    assert.throws(
      () =>
        validateDesktopReleaseBuildPolicy({
          env: {},
          platform: "linux",
          productionConfigMode: "off",
          releaseMode: "publish",
          signed: false,
        }),
      /production-config-mode strict/,
    );
  });

  it("requires Apple signing and notarization credentials for public macOS releases", () => {
    assert.throws(
      () =>
        validateDesktopReleaseBuildPolicy({
          env: envWith(APPLE_RELEASE_SIGNING_ENV_KEYS),
          platform: "mac",
          productionConfigMode: "strict",
          releaseMode: "publish",
          signed: false,
        }),
      /require --signed/,
    );
    assert.throws(
      () =>
        validateDesktopReleaseBuildPolicy({
          env: envWith(APPLE_RELEASE_SIGNING_ENV_KEYS.slice(0, -1)),
          platform: "mac",
          productionConfigMode: "strict",
          releaseMode: "publish",
          signed: true,
        }),
      /APPLE_API_ISSUER/,
    );
    assert.doesNotThrow(() =>
      validateDesktopReleaseBuildPolicy({
        env: envWith(APPLE_RELEASE_SIGNING_ENV_KEYS),
        platform: "mac",
        productionConfigMode: "strict",
        releaseMode: "publish",
        signed: true,
      }),
    );
  });

  it("rejects Azure Trusted Signing before inspecting credentials and directs releases to SSL.com", () => {
    assert.throws(
      () =>
        validateDesktopReleaseBuildPolicy({
          env: {
            AZURE_TENANT_ID: "must-not-be-used",
            AZURE_CLIENT_ID: "must-not-be-used",
            AZURE_CLIENT_SECRET: "must-not-be-used",
            WINDOWS_SIGNING_PROVIDER: "azure",
          },
          platform: "win",
          productionConfigMode: "strict",
          releaseMode: "publish",
          signed: true,
        }),
      /Azure Trusted Signing is disabled.*vendor payload bytes.*WINDOWS_SIGNING_PROVIDER=sslcom/,
    );
    assert.throws(
      () => validateWindowsSigningEnvironment({ WINDOWS_SIGNING_PROVIDER: "azure" }),
      /Azure Trusted Signing is disabled.*WINDOWS_SIGNING_PROVIDER=sslcom/,
    );
  });

  it("accepts a complete SSL.com eSigner environment and fails closed when setup is missing", () => {
    const sslComEnvironment = {
      ...envWith(WINDOWS_SSL_COM_RELEASE_SIGNING_ENV_KEYS),
      SSL_COM_PUBLISHER_NAME: "CN=Moss Test, O=Moss Test, C=CN",
      SSL_COM_CERTIFICATE_THUMBPRINT: "0123456789ABCDEF0123456789ABCDEF01234567",
    };
    assert.throws(
      () =>
        validateWindowsSigningEnvironment({
          ...sslComEnvironment,
          CODE_SIGN_TOOL_PATH: "",
          WINDOWS_SIGNING_PROVIDER: "sslcom",
        }),
      /CODE_SIGN_TOOL_PATH/,
    );
    assert.equal(
      validateWindowsSigningEnvironment({
        ...sslComEnvironment,
        WINDOWS_SIGNING_PROVIDER: "sslcom",
      }),
      "sslcom",
    );
    assert.throws(
      () =>
        validateWindowsSigningEnvironment({
          ...sslComEnvironment,
          SSL_COM_PUBLISHER_NAME: "Moss Test",
          WINDOWS_SIGNING_PROVIDER: "sslcom",
        }),
      /full distinguished subject/,
    );
    assert.throws(
      () =>
        validateWindowsSigningEnvironment({
          ...sslComEnvironment,
          SSL_COM_CERTIFICATE_THUMBPRINT: "not-a-thumbprint",
          WINDOWS_SIGNING_PROVIDER: "sslcom",
        }),
      /40 hexadecimal characters/,
    );
  });

  it("rejects missing or unsupported Windows signing provider selection", () => {
    assert.throws(() => validateWindowsSigningEnvironment({}), /WINDOWS_SIGNING_PROVIDER/);
    assert.throws(
      () => validateWindowsSigningEnvironment({ WINDOWS_SIGNING_PROVIDER: "unknown" }),
      /Unsupported Windows signing provider/,
    );
  });

  it("allows unsigned Linux publication only after strict public config validation", () => {
    assert.doesNotThrow(() =>
      validateDesktopReleaseBuildPolicy({
        env: {},
        platform: "linux",
        productionConfigMode: "strict",
        releaseMode: "publish",
        signed: false,
      }),
    );
  });
});
