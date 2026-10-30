import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOSS_BUNDLED_CODEX_ERROR_ENV_KEY,
  MOSS_BUNDLED_CODEX_PATH_ENV_KEY,
  MOSS_BUNDLED_CODEX_VERSION,
  resolveCodexRuntimeTarget,
} from "@synara/shared/codexRuntime";

import {
  resolveBundledCodexBinary,
  resolveBundledCodexBinaryAsync,
  toBundledCodexBackendEnv,
} from "./bundledCodex";
import { createRejectedFileAliasSync } from "./testing/desktopFilesystemFixtures";

const tempDirs = new Set<string>();
const exactVersionProbe = () => ({
  ok: true as const,
  output: `codex-cli ${MOSS_BUNDLED_CODEX_VERSION}\n`,
});
function makeResourcesRoot(): string {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-bundled-codex-test-"));
  tempDirs.add(root);
  return root;
}

function stageRuntimeFixture(input: {
  readonly resourcesPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly version?: string;
  readonly nested?: boolean;
  readonly copied?: boolean;
}) {
  const target = resolveCodexRuntimeTarget({ platform: input.platform, arch: input.arch });
  if (!target) throw new Error("unsupported fixture target");
  const packageLeaf = target.packageName.slice("@openai/".length);
  const packageRoot = input.nested
    ? Path.join(
        input.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        packageLeaf,
      )
    : Path.join(input.resourcesPath, "app.asar.unpacked", "node_modules", "@openai", packageLeaf);
  const vendorRoot = input.copied
    ? Path.join(input.resourcesPath, "codex-runtime", target.targetTriple)
    : Path.join(packageRoot, "vendor", target.targetTriple);
  const binaryPath = Path.join(vendorRoot, "bin", target.executableName);
  const executableSuffix = input.platform === "win32" ? ".exe" : "";
  const codeModeHostPath = Path.join(vendorRoot, "bin", `codex-code-mode-host${executableSuffix}`);
  const ripgrepPath = Path.join(vendorRoot, "codex-path", `rg${executableSuffix}`);
  const codexResourcesPath = Path.join(vendorRoot, "codex-resources");
  const manifestPath = Path.join(vendorRoot, "codex-package.json");
  FS.mkdirSync(Path.dirname(binaryPath), { recursive: true });
  FS.mkdirSync(Path.dirname(ripgrepPath), { recursive: true });
  FS.mkdirSync(codexResourcesPath, { recursive: true });
  FS.writeFileSync(binaryPath, "fixture");
  FS.writeFileSync(codeModeHostPath, "fixture");
  FS.writeFileSync(ripgrepPath, "fixture");
  if (input.platform !== "win32") {
    FS.chmodSync(binaryPath, 0o755);
    FS.chmodSync(codeModeHostPath, 0o755);
    FS.chmodSync(ripgrepPath, 0o755);
  }
  FS.writeFileSync(
    manifestPath,
    JSON.stringify({
      layoutVersion: 1,
      version: input.version ?? MOSS_BUNDLED_CODEX_VERSION,
      target: target.targetTriple,
      variant: "codex",
      entrypoint: `bin/${target.executableName}`,
      resourcesDir: "codex-resources",
      pathDir: "codex-path",
    }),
  );
  return {
    binaryPath,
    codeModeHostPath,
    codexResourcesPath,
    manifestPath,
    ripgrepPath,
    target,
    vendorRoot,
  };
}

afterEach(() => {
  for (const directory of tempDirs) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("resolveBundledCodexBinary", () => {
  it("awaits a cold startup probe before exposing a verified runtime", async () => {
    const resourcesPath = makeResourcesRoot();
    const fixture = stageRuntimeFixture({
      resourcesPath,
      platform: "win32",
      arch: "x64",
      copied: true,
    });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const pending = resolveBundledCodexBinaryAsync(
      { resourcesPath, platform: "win32", arch: "x64" },
      {
        probeExecutableVersion: async () => {
          await ready;
          return exactVersionProbe();
        },
      },
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await pending).toMatchObject({ ok: true, binaryPath: fixture.binaryPath });
  });

  it("does not accept a manifest changed while its startup probe is running", async () => {
    const resourcesPath = makeResourcesRoot();
    const fixture = stageRuntimeFixture({
      resourcesPath,
      platform: "win32",
      arch: "x64",
      copied: true,
    });
    const result = await resolveBundledCodexBinaryAsync(
      { resourcesPath, platform: "win32", arch: "x64" },
      {
        probeExecutableVersion: async () => {
          FS.writeFileSync(fixture.manifestPath, "{}");
          return exactVersionProbe();
        },
      },
    );
    expect(result).toMatchObject({ ok: false, code: "invalid-manifest" });
  });

  it("retains version and timeout guards during asynchronous startup", async () => {
    const resourcesPath = makeResourcesRoot();
    stageRuntimeFixture({ resourcesPath, platform: "win32", arch: "x64", copied: true });
    const input = { resourcesPath, platform: "win32" as const, arch: "x64" };
    expect(
      await resolveBundledCodexBinaryAsync(input, {
        probeExecutableVersion: async () => ({ ok: true, output: "codex-cli 0.1.0" }),
      }),
    ).toMatchObject({ ok: false, code: "executable-version-mismatch" });
    const timeout = await resolveBundledCodexBinaryAsync(input, {
      probeExecutableVersion: async () => ({
        ok: false,
        reason: "timeout",
        message: "private diagnostic",
      }),
    });
    expect(timeout).toMatchObject({ ok: false, code: "executable-version-unavailable" });
    expect(JSON.stringify(timeout)).not.toContain("private diagnostic");
  });

  it("resolves and version-checks a hoisted packaged runtime", () => {
    const resourcesPath = makeResourcesRoot();
    const fixture = stageRuntimeFixture({ resourcesPath, platform: "darwin", arch: "arm64" });

    expect(
      resolveBundledCodexBinary(
        { resourcesPath, platform: "darwin", arch: "arm64" },
        { probeExecutableVersion: exactVersionProbe },
      ),
    ).toEqual({
      ok: true,
      binaryPath: fixture.binaryPath,
      version: MOSS_BUNDLED_CODEX_VERSION,
      target: fixture.target,
    });
  });

  it.each([
    { platform: "darwin" as const, arch: "arm64" },
    { platform: "win32" as const, arch: "x64" },
  ])(
    "resolves and version-checks a copied $platform/$arch packaged runtime",
    ({ platform, arch }) => {
      const resourcesPath = makeResourcesRoot();
      const fixture = stageRuntimeFixture({ resourcesPath, platform, arch, copied: true });

      expect(
        resolveBundledCodexBinary(
          { resourcesPath, platform, arch },
          { probeExecutableVersion: exactVersionProbe },
        ),
      ).toEqual({
        ok: true,
        binaryPath: fixture.binaryPath,
        version: MOSS_BUNDLED_CODEX_VERSION,
        target: fixture.target,
      });
    },
  );

  it("supports the nested optional-dependency layout produced by npm", () => {
    const resourcesPath = makeResourcesRoot();
    const fixture = stageRuntimeFixture({
      resourcesPath,
      platform: "darwin",
      arch: "x64",
      nested: true,
    });

    const result = resolveBundledCodexBinary(
      { resourcesPath, platform: "darwin", arch: "x64" },
      { probeExecutableVersion: exactVersionProbe },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.binaryPath).toBe(fixture.binaryPath);
  });

  it.each(["codeModeHostPath", "ripgrepPath", "codexResourcesPath"] as const)(
    "rejects a runtime missing required layout entry %s before probing the executable",
    (missingEntry) => {
      const resourcesPath = makeResourcesRoot();
      const fixture = stageRuntimeFixture({
        resourcesPath,
        platform: "darwin",
        arch: "arm64",
        copied: true,
      });
      FS.rmSync(fixture[missingEntry], { recursive: true, force: true });
      const probeExecutableVersion = vi.fn(exactVersionProbe);

      expect(
        resolveBundledCodexBinary(
          { resourcesPath, platform: "darwin", arch: "arm64" },
          { probeExecutableVersion },
        ),
      ).toMatchObject({ ok: false, code: "invalid-layout" });
      expect(probeExecutableVersion).not.toHaveBeenCalled();
    },
  );

  it("rejects a symlinked runtime manifest before probing the executable", () => {
    const resourcesPath = makeResourcesRoot();
    const fixture = stageRuntimeFixture({
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
      copied: true,
    });
    const realManifestPath = `${fixture.manifestPath}.real`;
    FS.renameSync(fixture.manifestPath, realManifestPath);
    createRejectedFileAliasSync(realManifestPath, fixture.manifestPath);
    const probeExecutableVersion = vi.fn(exactVersionProbe);

    expect(
      resolveBundledCodexBinary(
        { resourcesPath, platform: "darwin", arch: "arm64" },
        { probeExecutableVersion },
      ),
    ).toMatchObject({ ok: false, code: "invalid-manifest" });
    expect(probeExecutableVersion).not.toHaveBeenCalled();
  });

  it.each(["codeModeHostPath", "ripgrepPath"] as const)(
    "rejects a symlinked required sidecar %s before probing the executable",
    (sidecarEntry) => {
      const resourcesPath = makeResourcesRoot();
      const fixture = stageRuntimeFixture({
        resourcesPath,
        platform: "darwin",
        arch: "arm64",
        copied: true,
      });
      const realSidecarPath = `${fixture[sidecarEntry]}.real`;
      FS.renameSync(fixture[sidecarEntry], realSidecarPath);
      createRejectedFileAliasSync(realSidecarPath, fixture[sidecarEntry]);
      const probeExecutableVersion = vi.fn(exactVersionProbe);

      expect(
        resolveBundledCodexBinary(
          { resourcesPath, platform: "darwin", arch: "arm64" },
          { probeExecutableVersion },
        ),
      ).toMatchObject({ ok: false, code: "invalid-layout" });
      expect(probeExecutableVersion).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["resourcesDir", "elsewhere"],
    ["pathDir", "elsewhere"],
  ] as const)("rejects an unexpected manifest %s", (field, value) => {
    const resourcesPath = makeResourcesRoot();
    const fixture = stageRuntimeFixture({
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
      copied: true,
    });
    const manifest = JSON.parse(FS.readFileSync(fixture.manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    FS.writeFileSync(fixture.manifestPath, JSON.stringify({ ...manifest, [field]: value }));

    expect(
      resolveBundledCodexBinary(
        { resourcesPath, platform: "darwin", arch: "arm64" },
        { probeExecutableVersion: exactVersionProbe },
      ),
    ).toMatchObject({ ok: false, code: "invalid-manifest" });
  });

  it("fails closed on an invalid copied runtime instead of accepting a stale unpacked fallback", () => {
    const resourcesPath = makeResourcesRoot();
    const copied = stageRuntimeFixture({
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
      copied: true,
    });
    stageRuntimeFixture({
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
      nested: true,
    });
    FS.writeFileSync(copied.manifestPath, "not-json");
    const probeExecutableVersion = vi.fn(exactVersionProbe);

    expect(
      resolveBundledCodexBinary(
        { resourcesPath, platform: "darwin", arch: "arm64" },
        { probeExecutableVersion },
      ),
    ).toMatchObject({ ok: false, code: "invalid-manifest" });
    expect(probeExecutableVersion).not.toHaveBeenCalled();
  });

  it("rejects a pinned manifest when the selected executable reports another version", () => {
    const resourcesPath = makeResourcesRoot();
    const target = resolveCodexRuntimeTarget({ platform: process.platform, arch: process.arch });
    if (!target) throw new Error("the test host must have a supported bundled Codex target");
    stageRuntimeFixture({
      resourcesPath,
      platform: target.platform,
      arch: target.arch,
      version: MOSS_BUNDLED_CODEX_VERSION,
    });
    const probeExecutableVersion = vi.fn(() => ({
      ok: true as const,
      output: "codex-cli 0.145.0\n",
    }));

    const result = resolveBundledCodexBinary(
      { resourcesPath, platform: target.platform, arch: target.arch },
      { probeExecutableVersion },
    );

    expect(result).toMatchObject({ ok: false, code: "executable-version-mismatch" });
    if (!result.ok) {
      expect(result.message).toContain(MOSS_BUNDLED_CODEX_VERSION);
      expect(result.message).toContain("0.145.0");
    }
    expect(probeExecutableVersion).toHaveBeenCalledTimes(1);
  });

  it("does not expose raw executable probe output through the backend diagnostic", () => {
    const resourcesPath = makeResourcesRoot();
    stageRuntimeFixture({
      resourcesPath,
      platform: "darwin",
      arch: "arm64",
      copied: true,
    });
    const secret = `token-secret ${process.env.HOME ?? "/private/home"} \u001b[31m`;
    const resolution = resolveBundledCodexBinary(
      { resourcesPath, platform: "darwin", arch: "arm64" },
      { probeExecutableVersion: () => ({ ok: false, message: secret }) },
    );

    expect(resolution).toMatchObject({ ok: false, code: "executable-version-unavailable" });
    if (resolution.ok) throw new Error("expected a failed resolution");
    expect(resolution.message).not.toContain("token-secret");
    expect(resolution.message).not.toContain(process.env.HOME ?? "/private/home");
    expect(resolution.message).not.toContain("\u001b");
    expect(toBundledCodexBackendEnv(resolution)[MOSS_BUNDLED_CODEX_ERROR_ENV_KEY]).toBe(
      resolution.message,
    );
  });

  it("accepts the selected executable only when it reports the exact pinned version", () => {
    const resourcesPath = makeResourcesRoot();
    const target = resolveCodexRuntimeTarget({ platform: process.platform, arch: process.arch });
    if (!target) throw new Error("the test host must have a supported bundled Codex target");
    const fixture = stageRuntimeFixture({
      resourcesPath,
      platform: target.platform,
      arch: target.arch,
      version: MOSS_BUNDLED_CODEX_VERSION,
    });

    expect(
      resolveBundledCodexBinary(
        { resourcesPath, platform: target.platform, arch: target.arch },
        {
          probeExecutableVersion: () => ({
            ok: true,
            output: `codex-cli ${MOSS_BUNDLED_CODEX_VERSION}\n`,
          }),
        },
      ),
    ).toEqual({
      ok: true,
      binaryPath: fixture.binaryPath,
      version: MOSS_BUNDLED_CODEX_VERSION,
      target,
    });
  });

  it("returns an actionable error for unsupported packaged targets", () => {
    const result = resolveBundledCodexBinary({
      resourcesPath: makeResourcesRoot(),
      platform: "freebsd",
      arch: "x64",
    });

    expect(result).toMatchObject({ ok: false, code: "unsupported-target" });
    if (!result.ok) {
      expect(result.message).toContain("freebsd/x64");
      expect(result.message).toContain("supported Moss build");
    }
  });

  it("returns an actionable error when the packaged runtime is absent", () => {
    const result = resolveBundledCodexBinary({
      resourcesPath: makeResourcesRoot(),
      platform: "darwin",
      arch: "arm64",
    });

    expect(result).toMatchObject({ ok: false, code: "missing-runtime" });
    if (!result.ok) {
      expect(result.message).toContain("Reinstall Moss");
      expect(result.message).not.toContain(process.env.HOME ?? "<unset-home>");
    }
  });

  it("rejects a mismatched npm runtime version", () => {
    const resourcesPath = makeResourcesRoot();
    stageRuntimeFixture({
      resourcesPath,
      platform: "linux",
      arch: "x64",
      version: "0.1.0",
    });

    const result = resolveBundledCodexBinary({ resourcesPath, platform: "linux", arch: "x64" });
    expect(result).toMatchObject({ ok: false, code: "version-mismatch" });
    if (!result.ok) {
      expect(result.message).toContain(MOSS_BUNDLED_CODEX_VERSION);
      expect(result.message).toContain("0.1.0");
    }
  });

  it("passes only a verified path or safe diagnostic to the backend", () => {
    const resourcesPath = makeResourcesRoot();
    const fixture = stageRuntimeFixture({ resourcesPath, platform: "darwin", arch: "arm64" });
    const success = resolveBundledCodexBinary(
      {
        resourcesPath,
        platform: "darwin",
        arch: "arm64",
      },
      { probeExecutableVersion: exactVersionProbe },
    );
    const failure = resolveBundledCodexBinary({
      resourcesPath: makeResourcesRoot(),
      platform: "darwin",
      arch: "arm64",
    });

    expect(toBundledCodexBackendEnv(success)).toEqual({
      [MOSS_BUNDLED_CODEX_PATH_ENV_KEY]: fixture.binaryPath,
    });
    const failureEnv = toBundledCodexBackendEnv(failure);
    expect(failureEnv[MOSS_BUNDLED_CODEX_PATH_ENV_KEY]).toBeUndefined();
    expect(failureEnv[MOSS_BUNDLED_CODEX_ERROR_ENV_KEY]).toContain("Reinstall Moss");
  });
});
