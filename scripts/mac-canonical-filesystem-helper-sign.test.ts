import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { createDirectoryAlias, createRejectedFileAlias } from "./fixtures/filesystem-links";

const posixSigningTest = it.runIf(process.platform !== "win32");

type ReadHook = {
  beforeOpen?: (filePath: string) => void;
};

type SignOptions = {
  app: string;
  optionsForFile?: (filePath: string) => { entitlements: string } | undefined;
};

type SignReceipt = {
  refreshCount: number;
  helperPath: string;
  metadataPath: string;
  sha256: string;
  size: number;
};

type BindingReceipt = {
  helperSha256: string;
};

type HookModule = {
  parseAndValidateMetadata: (bytes: Buffer, metadataPath: string) => Record<string, unknown>;
  MAC_CANONICAL_FILESYSTEM_HELPER_APP_RELATIVE_PATH: string;
  MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_APP_RELATIVE_PATH: string;
  refreshPackagedCanonicalFilesystemHelperMetadata: (
    appPath: string,
    hooks?: { readHooks?: { helper?: ReadHook; metadata?: ReadHook } },
  ) => {
    helperPath: string;
    metadataPath: string;
    sha256: string;
    size: number;
    refreshCount: number;
  };
  signMacCanonicalFilesystemHelperAware: (
    options: SignOptions,
    signImplementation?: (options: SignOptions) => Promise<void>,
  ) => Promise<SignReceipt>;
  verifyPackagedCanonicalFilesystemHelperBinding: (appPath: string) => BindingReceipt;
  wrapMacSignOptionsForCanonicalFilesystemHelper: (options: SignOptions) => {
    options: SignOptions;
    state: { refreshCount: number };
  };
  writeCanonicalFilesystemHelperMetadataAtomically: (
    metadataPath: string,
    expectedRealPath: string,
    nextMetadata: Record<string, unknown>,
    mode: number,
    hooks?: { pendingPath?: string; beforeRename?: (pendingPath: string) => void },
  ) => void;
};

const require = createRequire(import.meta.url);
const {
  parseAndValidateMetadata,
  MAC_CANONICAL_FILESYSTEM_HELPER_APP_RELATIVE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_APP_RELATIVE_PATH,
  refreshPackagedCanonicalFilesystemHelperMetadata,
  signMacCanonicalFilesystemHelperAware,
  verifyPackagedCanonicalFilesystemHelperBinding,
  wrapMacSignOptionsForCanonicalFilesystemHelper,
  writeCanonicalFilesystemHelperMetadataAtomically,
} = require("./mac-canonical-filesystem-helper-sign.mjs") as HookModule;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readMetadata(metadataPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
}

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "moss-helper-sign-"));
  const appPath = path.join(root, "Moss.app");
  const helperPath = path.join(appPath, MAC_CANONICAL_FILESYSTEM_HELPER_APP_RELATIVE_PATH);
  const metadataPath = path.join(
    appPath,
    MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_APP_RELATIVE_PATH,
  );
  mkdirSync(path.dirname(helperPath), { recursive: true });
  mkdirSync(path.dirname(metadataPath), { recursive: true });

  const initialHelper = Buffer.from("#!/bin/sh\necho initial\n");
  writeFileSync(helperPath, initialHelper, { mode: 0o755 });
  writeFileSync(
    metadataPath,
    `${JSON.stringify({
      schemaVersion: 1,
      helper: "moss-canonical-filesystem-helper",
      protocolVersion: 2,
      arch: "arm64",
      architectures: ["arm64"],
      fingerprint: "f".repeat(64),
      sha256: sha256(initialHelper),
      size: initialHelper.byteLength,
    })}\n`,
    { mode: 0o644 },
  );

  return {
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
    root,
    appPath,
    helperPath,
    metadataPath,
  };
}

describe("mac canonical filesystem helper signing hook", () => {
  it.runIf(process.platform === "win32")(
    "rejects missing POSIX executable identity without rewriting metadata",
    () => {
      const fixture = makeFixture();
      try {
        const before = readFileSync(fixture.metadataPath);
        expect(() => refreshPackagedCanonicalFilesystemHelperMetadata(fixture.appPath)).toThrow(
          /must remain executable/,
        );
        expect(readFileSync(fixture.metadataPath)).toEqual(before);
        expect(() => verifyPackagedCanonicalFilesystemHelperBinding(fixture.appPath)).toThrow(
          /must remain executable/,
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  posixSigningTest("fails closed when the packaged sidecar is missing", () => {
    const fixture = makeFixture();
    try {
      unlinkSync(fixture.metadataPath);
      expect(() => refreshPackagedCanonicalFilesystemHelperMetadata(fixture.appPath)).toThrow(
        /non-symlink regular file/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects malformed metadata schema without mutating the original sidecar", () => {
    const fixture = makeFixture();
    try {
      const original = readFileSync(fixture.metadataPath, "utf8");
      writeFileSync(
        fixture.metadataPath,
        `${JSON.stringify({
          ...readMetadata(fixture.metadataPath),
          protocolVersion: 999,
        })}\n`,
      );

      expect(() =>
        parseAndValidateMetadata(readFileSync(fixture.metadataPath), fixture.metadataPath),
      ).toThrow(/metadata is invalid/);
      expect(readFileSync(fixture.metadataPath, "utf8")).not.toBe(original);
      expect(readMetadata(fixture.metadataPath).protocolVersion).toBe(999);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects helper symlink escapes outside the packaged app boundary", () => {
    const fixture = makeFixture();
    try {
      const escapedHelper = path.join(fixture.root, "escaped-helper");
      writeFileSync(escapedHelper, "#!/bin/sh\necho escape\n", { mode: 0o755 });
      unlinkSync(fixture.helperPath);
      createRejectedFileAlias(escapedHelper, fixture.helperPath);

      expect(() => refreshPackagedCanonicalFilesystemHelperMetadata(fixture.appPath)).toThrow(
        /non-symlink regular file/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  posixSigningTest("rejects metadata symlink escapes outside the packaged app boundary", () => {
    const fixture = makeFixture();
    try {
      const escapedMetadata = path.join(fixture.root, "escaped-metadata.json");
      writeFileSync(escapedMetadata, readFileSync(fixture.metadataPath, "utf8"));
      unlinkSync(fixture.metadataPath);
      createRejectedFileAlias(escapedMetadata, fixture.metadataPath);

      expect(() => refreshPackagedCanonicalFilesystemHelperMetadata(fixture.appPath)).toThrow(
        /non-symlink regular file/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  posixSigningTest("fails closed if the Helpers directory becomes a symlink before open", () => {
    const fixture = makeFixture();
    try {
      const escapedHelpers = path.join(fixture.root, "escaped-helpers");
      mkdirSync(escapedHelpers, { recursive: true });
      writeFileSync(
        path.join(escapedHelpers, path.basename(fixture.helperPath)),
        "#!/bin/sh\necho escaped\n",
        { mode: 0o755 },
      );

      expect(() =>
        refreshPackagedCanonicalFilesystemHelperMetadata(fixture.appPath, {
          readHooks: {
            helper: {
              beforeOpen() {
                rmSync(fixture.helperPath, { force: true });
                rmSync(path.dirname(fixture.helperPath), { recursive: true, force: true });
                createDirectoryAlias(escapedHelpers, path.dirname(fixture.helperPath));
              },
            },
          },
        }),
      ).toThrow(/unexpected symlinked parent/);
    } finally {
      fixture.cleanup();
    }
  });

  posixSigningTest("refreshes packaged helper metadata to the final signed helper bytes", () => {
    const fixture = makeFixture();
    try {
      const signedHelper = Buffer.concat([
        readFileSync(fixture.helperPath),
        Buffer.from("signed-payload"),
      ]);
      writeFileSync(fixture.helperPath, signedHelper, { mode: 0o755 });

      const receipt = refreshPackagedCanonicalFilesystemHelperMetadata(fixture.appPath);
      const metadata = readMetadata(fixture.metadataPath);

      expect(receipt.helperPath).toBe(fixture.helperPath);
      expect(receipt.metadataPath).toBe(fixture.metadataPath);
      expect(metadata.sha256).toBe(sha256(signedHelper));
      expect(metadata.size).toBe(signedHelper.byteLength);
      expect(metadata.fingerprint).toBe("f".repeat(64));
      expect(metadata.architectures).toEqual(["arm64"]);
      expect(verifyPackagedCanonicalFilesystemHelperBinding(fixture.appPath).helperSha256).toBe(
        sha256(signedHelper),
      );
    } finally {
      fixture.cleanup();
    }
  });

  posixSigningTest("waits until the outer app signature step before rewriting metadata", () => {
    const fixture = makeFixture();
    try {
      const signedHelper = Buffer.concat([
        readFileSync(fixture.helperPath),
        Buffer.from("signed-payload"),
      ]);
      writeFileSync(fixture.helperPath, signedHelper, { mode: 0o755 });

      const wrapped = wrapMacSignOptionsForCanonicalFilesystemHelper({
        app: fixture.appPath,
        optionsForFile(filePath: string) {
          return { entitlements: `${filePath}.plist` };
        },
      });

      wrapped.options.optionsForFile?.(fixture.helperPath);
      const beforeOuterAppSign = readMetadata(fixture.metadataPath);
      expect(beforeOuterAppSign.sha256).not.toBe(sha256(signedHelper));

      const appOptions = wrapped.options.optionsForFile?.(fixture.appPath);
      const afterOuterAppSign = readMetadata(fixture.metadataPath);
      expect(appOptions).toEqual({ entitlements: `${fixture.appPath}.plist` });
      expect(afterOuterAppSign.sha256).toBe(sha256(signedHelper));
      expect(afterOuterAppSign.size).toBe(signedHelper.byteLength);
      expect(wrapped.state.refreshCount).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  posixSigningTest(
    "re-refreshes metadata for every top-level signing attempt and keeps retry-safe postconditions",
    async () => {
      const fixture = makeFixture();
      try {
        const helperAfterFirstAttempt = Buffer.concat([
          readFileSync(fixture.helperPath),
          Buffer.from("signed-once"),
        ]);
        const helperAfterSecondAttempt = Buffer.concat([
          helperAfterFirstAttempt,
          Buffer.from("signed-twice"),
        ]);
        const receipt = await signMacCanonicalFilesystemHelperAware(
          {
            app: fixture.appPath,
            optionsForFile(filePath: string) {
              return { entitlements: `${filePath}.plist` };
            },
          },
          async (options: SignOptions) => {
            for (const nextHelper of [helperAfterFirstAttempt, helperAfterSecondAttempt]) {
              writeFileSync(fixture.helperPath, nextHelper, { mode: 0o755 });
              options.optionsForFile?.(fixture.appPath);
            }
          },
        );

        const metadata = readMetadata(fixture.metadataPath);
        expect(receipt.refreshCount).toBe(2);
        expect(metadata.sha256).toBe(sha256(helperAfterSecondAttempt));
        expect(metadata.size).toBe(helperAfterSecondAttempt.byteLength);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("fails closed when the signer never reaches the top-level app callback", async () => {
    const fixture = makeFixture();
    try {
      await expect(
        signMacCanonicalFilesystemHelperAware({ app: fixture.appPath }, async () => {
          // no outer app callback
        }),
      ).rejects.toThrow(/metadata refresh did not run/);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the original metadata file untouched when atomic rename does not happen", () => {
    const fixture = makeFixture();
    try {
      const original = readFileSync(fixture.metadataPath, "utf8");
      const nextMetadata = {
        ...readMetadata(fixture.metadataPath),
        sha256: "a".repeat(64),
        size: 123,
      };

      expect(() =>
        writeCanonicalFilesystemHelperMetadataAtomically(
          fixture.metadataPath,
          fixture.metadataPath,
          nextMetadata,
          0o644,
          {
            pendingPath: path.join(path.dirname(fixture.metadataPath), ".collision.tmp"),
            beforeRename() {
              throw new Error("stop before rename");
            },
          },
        ),
      ).toThrow(
        process.platform === "win32" ? /temp file has an unexpected mode/ : /stop before rename/,
      );

      expect(readFileSync(fixture.metadataPath, "utf8")).toBe(original);
    } finally {
      fixture.cleanup();
    }
  });

  it("loads under plain node module resolution through the electron-builder dependency chain", () => {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    const moduleUrl = pathToFileURL(
      path.join(scriptsDir, "mac-canonical-filesystem-helper-sign.mjs"),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const mod = await import(${JSON.stringify(moduleUrl)}); console.log(Object.keys(mod).length);`,
      ],
      {
        cwd: scriptsDir,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("9");
    expect(result.stderr).toBe("");
  });
});
