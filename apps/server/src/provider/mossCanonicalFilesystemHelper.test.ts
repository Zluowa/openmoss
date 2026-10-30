import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeMossCanonicalFilesystemHelper,
  type MossCanonicalFilesystemHelperInput,
} from "./mossCanonicalFilesystemHelper.ts";

const tempDirectories: string[] = [];
const zeroFingerprint = "0".repeat(64);
// A Darwin artifact's executable-mode and native protocol prerequisites cannot
// be manufactured with Windows chmod; exercise the explicit refusal instead.
const posixArtifactIt = it.skipIf(process.platform === "win32");

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function helperInput(
  overrides: Partial<MossCanonicalFilesystemHelperInput> = {},
): MossCanonicalFilesystemHelperInput {
  return {
    cwd: process.cwd(),
    action: "create",
    rootSegments: [".moss"],
    targetSegments: ["skills", "example", "SKILL.md"],
    expectedWorkspace: { dev: 1, ino: 2 },
    expectedRoot: { dev: 3, ino: 4 },
    expectedParent: { dev: 5, ino: 6 },
    expectedTarget: { kind: "missing" },
    expectedBeforeFingerprint: zeroFingerprint,
    expectedAfterFingerprint: zeroFingerprint,
    expectedAfterKind: "file",
    payload: { kind: "file", content: new TextEncoder().encode("hello\n") },
    ...overrides,
  };
}

async function fakeHelper(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "moss-canonical-helper-protocol-"));
  tempDirectories.push(directory);
  const helperPath = join(directory, "helper");
  await writeFile(helperPath, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  await chmod(helperPath, 0o700);
  return helperPath;
}

async function writeValidMetadata(
  helperPath: string,
  overrides: Readonly<Record<string, unknown>> = {},
  metadataPath = `${helperPath}.build.json`,
): Promise<void> {
  const bytes = await readFile(helperPath);
  await writeFile(
    metadataPath,
    `${JSON.stringify({
      schemaVersion: 1,
      helper: "moss-canonical-filesystem-helper",
      protocolVersion: 2,
      arch: process.arch,
      architectures: [process.arch],
      fingerprint: "a".repeat(64),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      ...overrides,
    })}\n`,
  );
}

describe("Moss canonical filesystem helper protocol", () => {
  it.each(["linux", "win32"] as const)(
    "fails closed before spawning on unsupported %s platforms",
    async (platform) => {
      let spawned = false;
      const helper = makeMossCanonicalFilesystemHelper({
        platform,
        helperPath: "/never/run",
        spawn: () => {
          spawned = true;
          throw new Error("must not spawn");
        },
      });

      await expect(helper.execute(helperInput())).rejects.toMatchObject({
        code: "durability-unsupported",
      });
      expect(spawned).toBe(false);
    },
  );

  it("maps a missing helper to typed durability-unsupported", async () => {
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath: join(tmpdir(), "moss-canonical-helper-does-not-exist"),
    });

    await expect(helper.execute(helperInput())).rejects.toMatchObject({
      code: "durability-unsupported",
    });
  });

  it("rejects a missing artifact sidecar before spawning", async () => {
    const helperPath = await fakeHelper(
      'process.stdout.write("MOSS_CANONICAL_FS_HELPER_READY 2\\n");',
    );
    let spawned = false;
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath,
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });

    await expect(helper.execute(helperInput())).rejects.toMatchObject({
      code: "durability-unsupported",
    });
    expect(spawned).toBe(false);
  });

  posixArtifactIt(
    "validates separate packaged metadata before spawning in desktop mode",
    async () => {
      const helperPath = await fakeHelper(
        'process.stdout.write("MOSS_CANONICAL_FS_HELPER_READY 2\\n");',
      );
      const resourcesDirectory = join(dirname(helperPath), "Resources");
      const metadataPath = join(resourcesDirectory, "moss-canonical-filesystem-helper.build.json");
      await mkdir(resourcesDirectory);
      await writeValidMetadata(helperPath, {}, metadataPath);
      vi.stubEnv("MOSS_MODE", "desktop");
      vi.stubEnv("MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH", metadataPath);

      let spawned = false;
      const helper = makeMossCanonicalFilesystemHelper({
        platform: "darwin",
        helperPath,
        spawn: () => {
          spawned = true;
          throw new Error("validation completed before this controlled spawn failure");
        },
      });

      await expect(helper.execute(helperInput())).rejects.toMatchObject({
        code: "durability-unsupported",
      });
      expect(spawned).toBe(true);
    },
  );

  posixArtifactIt("rejects tampered separate packaged metadata before spawning", async () => {
    const helperPath = await fakeHelper(
      'process.stdout.write("MOSS_CANONICAL_FS_HELPER_READY 2\\n");',
    );
    const resourcesDirectory = join(dirname(helperPath), "Resources");
    const metadataPath = join(resourcesDirectory, "moss-canonical-filesystem-helper.build.json");
    await mkdir(resourcesDirectory);
    await writeValidMetadata(helperPath, { sha256: "0".repeat(64) }, metadataPath);
    vi.stubEnv("MOSS_MODE", "desktop");
    vi.stubEnv("MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH", metadataPath);

    let spawned = false;
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath,
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });

    await expect(helper.execute(helperInput())).rejects.toMatchObject({
      code: "durability-unsupported",
    });
    expect(spawned).toBe(false);
  });

  it("ignores ambient metadata path outside desktop mode", async () => {
    const helperPath = await fakeHelper(
      'process.stdout.write("MOSS_CANONICAL_FS_HELPER_READY 2\\n");',
    );
    const resourcesDirectory = join(dirname(helperPath), "Resources");
    const metadataPath = join(resourcesDirectory, "moss-canonical-filesystem-helper.build.json");
    await mkdir(resourcesDirectory);
    await writeValidMetadata(helperPath, {}, metadataPath);
    vi.stubEnv("MOSS_MODE", "server");
    vi.stubEnv("MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH", metadataPath);

    let spawned = false;
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath,
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });

    await expect(helper.execute(helperInput())).rejects.toMatchObject({
      code: "durability-unsupported",
    });
    expect(spawned).toBe(false);
  });

  posixArtifactIt("rejects a tampered binary or sidecar before spawning", async () => {
    const helperPath = await fakeHelper(
      'process.stdout.write("MOSS_CANONICAL_FS_HELPER_READY 2\\n");',
    );
    await writeValidMetadata(helperPath, { sha256: "0".repeat(64) });
    let spawned = false;
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath,
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });

    await expect(helper.execute(helperInput())).rejects.toMatchObject({
      code: "durability-unsupported",
    });
    expect(spawned).toBe(false);
  });

  posixArtifactIt("rejects a binary changed after a valid sidecar was generated", async () => {
    const helperPath = await fakeHelper(
      'process.stdout.write("MOSS_CANONICAL_FS_HELPER_READY 2\\n");',
    );
    await writeValidMetadata(helperPath);
    const bytes = await readFile(helperPath);
    await writeFile(helperPath, Buffer.concat([bytes, Buffer.from("tamper")]), { mode: 0o700 });
    let spawned = false;
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath,
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });

    await expect(helper.execute(helperInput())).rejects.toMatchObject({
      code: "durability-unsupported",
    });
    expect(spawned).toBe(false);
  });

  posixArtifactIt.each([
    ["wrong ready version", "MOSS_CANONICAL_FS_HELPER_READY 999\n"],
    ["extra stdout", "MOSS_CANONICAL_FS_HELPER_READY 2\nnoise\n"],
  ])("rejects %s as typed durability-unsupported", async (_label, output) => {
    const helperPath = await fakeHelper(`process.stdout.write(${JSON.stringify(output)});`);
    await writeValidMetadata(helperPath);
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath,
    });

    await expect(helper.execute(helperInput())).rejects.toMatchObject({
      code: "durability-unsupported",
    });
  });

  posixArtifactIt("maps a helper exit after request to recovery-needed", async () => {
    const helperPath = await fakeHelper(
      'process.stdout.write("MOSS_CANONICAL_FS_HELPER_READY 2\\n"); process.stdin.once("data", () => process.exit(17));',
    );
    await writeValidMetadata(helperPath);
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath,
      timeoutMs: 2_000,
    });

    await expect(helper.execute(helperInput())).rejects.toMatchObject({
      code: "recovery-needed",
    });
  });

  posixArtifactIt("maps an operation timeout to recovery-needed", async () => {
    const helperPath = await fakeHelper(
      'process.stdout.write("MOSS_CANONICAL_FS_HELPER_READY 2\\n"); setInterval(() => {}, 1000);',
    );
    await writeValidMetadata(helperPath);
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath,
      timeoutMs: 1_000,
    });

    await expect(helper.execute(helperInput())).rejects.toMatchObject({
      code: "recovery-needed",
    });
  });

  posixArtifactIt("maps an untrustworthy response after dispatch to recovery-needed", async () => {
    const helperPath = await fakeHelper(
      'process.stdout.write("MOSS_CANONICAL_FS_HELPER_READY 2\\n"); process.stdin.on("end", () => { process.stdout.write("malformed"); });',
    );
    await writeValidMetadata(helperPath);
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath,
    });

    await expect(helper.execute(helperInput())).rejects.toMatchObject({
      code: "recovery-needed",
    });
  });

  it.each([
    ["absolute target", ["/tmp", "target"]],
    ["parent traversal", ["skills", "..", "target"]],
    ["NUL target", ["skills", "bad\0target"]],
  ])("rejects %s before spawning", async (_label, targetSegments) => {
    let spawned = false;
    const helper = makeMossCanonicalFilesystemHelper({
      platform: "darwin",
      helperPath: "/never/run",
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });

    await expect(helper.execute(helperInput({ targetSegments }))).rejects.toMatchObject({
      code: "durability-unsupported",
    });
    expect(spawned).toBe(false);
  });
});
